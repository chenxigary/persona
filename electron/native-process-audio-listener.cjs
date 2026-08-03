"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AudioActivityGate, DEFAULT_SPEECH_RELEASE_MS } = require("./audio-activity-gate.cjs");
const { discoverVoiceProcesses } = require("./process-discovery.cjs");
const { normalizeVoiceSource } = require("./voice-source.cjs");

const SESSION_IDLE_MS = 8_000;
const MAX_PCM_BYTES_PER_MESSAGE = 16 * 1024;
const MAX_PCM_BASE64_LENGTH = Math.ceil(MAX_PCM_BYTES_PER_MESSAGE / 3) * 4;
const PCM_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Multi-process voice applications (Electron and Chromium based clients in
// particular) start and stop short-lived helper processes continuously. Those
// helpers rarely own a Core Audio process object, so rebuilding the tap for
// every membership change destroys and recreates the aggregate device without
// changing what is actually metered. Coalesce that churn.
const REATTACH_COOLDOWN_MS = 5_000;

function helperExecutableName(platform) {
  return platform === "win32" ? "persona-audio-listener.exe" : "persona-audio-listener";
}

function resolveNativeHelperPath({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, ".."),
} = {}) {
  const executable = helperExecutableName(platform);
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return isPackaged
    ? platformPath.join(resourcesPath, "native", platform, executable)
    : platformPath.join(projectRoot, "native", "bin", platform, executable);
}

function createNdjsonParser(onMessage, onInvalid = () => {}) {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        onInvalid(line);
      }
    }
  };
}

function decodePcmMessage(message) {
  if (
    message?.type !== "pcm" ||
    message.encoding !== "s16le" ||
    message.channels !== 1 ||
    !Number.isFinite(message.sampleRate) ||
    message.sampleRate < 8_000 ||
    message.sampleRate > 192_000 ||
    !Number.isSafeInteger(message.sequence) ||
    message.sequence < 0 ||
    typeof message.data !== "string" ||
    message.data.length === 0 ||
    message.data.length > MAX_PCM_BASE64_LENGTH ||
    message.data.length % 4 !== 0 ||
    !PCM_BASE64_PATTERN.test(message.data)
  ) {
    return null;
  }
  const data = Buffer.from(message.data, "base64");
  if (
    data.length === 0 ||
    data.length > MAX_PCM_BYTES_PER_MESSAGE ||
    data.length % 2 !== 0
  ) {
    return null;
  }
  const frames = data.length / 2;
  if (message.frames != null && message.frames !== frames) return null;
  return {
    channels: 1,
    data,
    encoding: "s16le",
    frames,
    sampleRate: Number(message.sampleRate),
    sequence: message.sequence,
  };
}

class NativeProcessAudioListener {
  constructor({
    platform = process.platform,
    isPackaged = false,
    resourcesPath = process.resourcesPath,
    helperPath = null,
    processDiscovery = discoverVoiceProcesses,
    spawnProcess = spawn,
    onActivity = () => {},
    onDebug = null,
    onLevel = () => {},
    onPcm = () => {},
    onSession = () => {},
    onStatus = () => {},
    pollIntervalMs = 1_500,
    sessionIdleMs = SESSION_IDLE_MS,
    speechReleaseMs = DEFAULT_SPEECH_RELEASE_MS,
    reattachCooldownMs = REATTACH_COOLDOWN_MS,
    emitPcm = false,
    now = () => Date.now(),
    processPattern = null,
    voiceSource = null,
  } = {}) {
    this.platform = platform;
    this.helperPath =
      helperPath ?? resolveNativeHelperPath({ platform, isPackaged, resourcesPath });
    this.processDiscovery = processDiscovery;
    this.processPattern = processPattern;
    this.voiceSource = normalizeVoiceSource(voiceSource);
    this.spawnProcess = spawnProcess;
    this.onActivity = onActivity;
    this.onDebug = onDebug;
    this.onPcm = onPcm;
    this.onSession = onSession;
    this.onStatus = onStatus;
    this.pollIntervalMs = pollIntervalMs;
    this.sessionIdleMs = sessionIdleMs;
    this.reattachCooldownMs = reattachCooldownMs;
    this.emitPcm = platform === "darwin" && emitPcm === true;
    this.now = now;
    this.capture = null;
    this.capturePids = [];
    this.captureStartingOutput = false;
    this.lastAttachAt = 0;
    this.pollTimer = null;
    this.sessionTimer = null;
    this.sessionActive = false;
    this.stopped = true;
    this.pollInFlight = false;
    this.lastStatusKey = null;
    this.gate = new AudioActivityGate({
      onActivity,
      onLevel,
      shouldReturnToListening: () => this.sessionActive,
      speechReleaseMs,
    });
  }

  reportStatus(status) {
    const key = JSON.stringify(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.onStatus(status);
  }

  async start() {
    if (!["darwin", "win32"].includes(this.platform) || !this.stopped) return;
    this.stopped = false;
    if (!fs.existsSync(this.helperPath)) {
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: false,
        source: null,
        error: `Native listener is missing: ${this.helperPath}`,
      });
      return;
    }
    this.reportStatus({
      available: true,
      capturing: false,
      monitoring: true,
      source: null,
    });
    await this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async poll() {
    if (this.stopped || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const processes = await this.processDiscovery({
        platform: this.platform,
        voiceSource: this.voiceSource,
        ...(this.processPattern ? { pattern: this.processPattern } : {}),
      });
      if (this.stopped) return;
      const selectedPids =
        this.platform === "win32" ? processes.rootPids.slice(0, 1) : processes.pids;
      if (!selectedPids.length) {
        this.detach();
        return;
      }
      if (!this.capture) {
        this.startCapture(selectedPids);
        return;
      }
      if (!this.shouldReattach(selectedPids)) return;
      this.detach({ sessionEnded: false });
      this.startCapture(selectedPids);
    } catch (error) {
      this.reportStatus({
        available: true,
        capturing: false,
        monitoring: true,
        source: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  shouldReattach(selectedPids) {
    const current = new Set(selectedPids);
    const retained = this.capturePids.filter((processId) => current.has(processId));
    // Everything we handed to the helper is gone, so the tap can no longer be
    // metering the target. Reattach immediately.
    if (!retained.length) return true;
    // Membership is identical: nothing to do.
    if (
      retained.length === this.capturePids.length &&
      selectedPids.length === this.capturePids.length
    ) {
      return false;
    }
    // The native helper has observed target output and is creating its Core
    // Audio tap, but the first meter sample has not arrived yet. Electron voice
    // apps often add a helper process in this exact window. Reattaching here
    // destroys a healthy brand-new tap before it can mark the session active.
    if (this.captureStartingOutput) return false;
    // A voice session is in flight, so the current tap is demonstrably carrying
    // the audio we care about. Rebuilding it now would interrupt the aggregate
    // device and reset animation state mid-sentence.
    if (this.sessionActive) return false;
    // The set drifted while we are still tapping live processes. Rebuilding the
    // Core Audio tap here is disruptive, so wait out the cooldown and pick the
    // accumulated drift up in a single reattach.
    return this.now() - this.lastAttachAt >= this.reattachCooldownMs;
  }

  startCapture(processIds) {
    const args = processIds.flatMap((processId) => ["--pid", String(processId)]);
    if (this.emitPcm) args.push("--emit-pcm");
    const child = this.spawnProcess(this.helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.capture = child;
    this.capturePids = [...processIds];
    this.captureStartingOutput = false;
    this.lastAttachAt = this.now();
    const parse = createNdjsonParser(
      (message) => this.handleHelperMessage(child, message),
      (line) =>
        this.onDebug?.(
          "native listener emitted invalid JSON",
          { bytes: Buffer.byteLength(line, "utf8") },
        ),
    );
    child.stdout.on("data", parse);
    child.stderr.on("data", (chunk) => this.onDebug?.("native listener stderr", chunk.toString()));
    child.once("error", (error) => {
      if (this.capture !== child) return;
      this.capture = null;
      this.capturePids = [];
      this.captureStartingOutput = false;
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: true,
        source: null,
        error: error.message,
      });
    });
    child.once("exit", (code, signal) => {
      if (this.capture !== child) return;
      this.capture = null;
      this.capturePids = [];
      this.captureStartingOutput = false;
      this.gate.reset();
      this.reportStatus({
        available: true,
        capturing: false,
        monitoring: !this.stopped,
        source: null,
        ...(code && !this.stopped
          ? { error: `Native listener exited with code ${code}${signal ? ` (${signal})` : ""}.` }
          : {}),
      });
    });
  }

  handleHelperMessage(child, message) {
    if (this.capture !== child || message == null || typeof message !== "object") return;
    if (message.type === "attaching") {
      this.captureStartingOutput = true;
      this.onDebug?.("native listener output detected; tap setup protected");
      return;
    }
    if (message.type === "ready") {
      // macOS sends an explicit `attaching` event first, so its protection
      // remains active through this ready-to-level gap. Windows deliberately
      // emits ready before any output and must not be protected indefinitely.
      if (this.captureStartingOutput) {
        this.onDebug?.("native listener tap ready; awaiting first active level");
      }
      this.reportStatus({
        available: true,
        capturing: true,
        monitoring: true,
        source: message.source || "Supported voice app",
      });
      return;
    }
    if (message.type === "waiting") {
      this.captureStartingOutput = false;
      // The helper is armed but deliberately not tapping yet: it defers the
      // Core Audio tap until the target reports running output, because a tap
      // attached while the target is negotiating a new audio session can keep
      // that session from connecting.
      this.reportStatus({
        available: true,
        capturing: false,
        monitoring: true,
        source: null,
      });
      return;
    }
    if (message.type === "error") {
      this.captureStartingOutput = false;
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: true,
        source: null,
        error: String(message.message || "Native listener failed."),
      });
      return;
    }
    if (message.type === "pcm") {
      const frame = decodePcmMessage(message);
      if (!frame) {
        this.onDebug?.("native listener emitted invalid PCM metadata");
        return;
      }
      try {
        this.onPcm(frame);
      } catch (error) {
        this.onDebug?.(
          "native listener PCM consumer failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }
    if (message.type === "pcm-overflow") {
      if (Number.isSafeInteger(message.dropped) && message.dropped > 0) {
        this.onDebug?.("native listener PCM ring overflow", message.dropped);
      }
      return;
    }
    if (message.type !== "level" || !Number.isFinite(message.level)) return;

    const level = Math.max(0, Math.min(1, Number(message.level)));
    if (level > 0.008) {
      if (this.captureStartingOutput) {
        this.onDebug?.("native listener first active level received");
      }
      this.captureStartingOutput = false;
      clearTimeout(this.sessionTimer);
      this.sessionTimer = setTimeout(() => this.endSession(), this.sessionIdleMs);
      this.sessionTimer.unref?.();
      if (!this.sessionActive) {
        this.sessionActive = true;
        this.onSession(true);
        this.onActivity("listening");
      }
    }
    this.gate.handleLevel(level);
  }

  endSession() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    if (!this.sessionActive) return;
    this.sessionActive = false;
    this.gate.reset();
    this.onSession(false);
  }

  detach({ sessionEnded = true } = {}) {
    if (this.capture) {
      const child = this.capture;
      this.capture = null;
      this.capturePids = [];
      this.captureStartingOutput = false;
      child.kill();
    }
    this.captureStartingOutput = false;
    this.gate.reset();
    if (sessionEnded) this.endSession();
    this.reportStatus({
      available: true,
      capturing: false,
      monitoring: !this.stopped,
      source: null,
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.detach();
  }
}

module.exports = {
  NativeProcessAudioListener,
  MAX_PCM_BYTES_PER_MESSAGE,
  REATTACH_COOLDOWN_MS,
  SESSION_IDLE_MS,
  createNdjsonParser,
  decodePcmMessage,
  helperExecutableName,
  resolveNativeHelperPath,
};
