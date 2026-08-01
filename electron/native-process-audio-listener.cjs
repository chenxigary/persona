"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AudioActivityGate, DEFAULT_SPEECH_RELEASE_MS } = require("./audio-activity-gate.cjs");
const { discoverVoiceProcesses } = require("./process-discovery.cjs");
const { normalizeVoiceSource } = require("./voice-source.cjs");

const SESSION_IDLE_MS = 8_000;

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
    onSession = () => {},
    onStatus = () => {},
    pollIntervalMs = 1_500,
    sessionIdleMs = SESSION_IDLE_MS,
    speechReleaseMs = DEFAULT_SPEECH_RELEASE_MS,
    reattachCooldownMs = REATTACH_COOLDOWN_MS,
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
    this.onSession = onSession;
    this.onStatus = onStatus;
    this.pollIntervalMs = pollIntervalMs;
    this.sessionIdleMs = sessionIdleMs;
    this.reattachCooldownMs = reattachCooldownMs;
    this.now = now;
    this.capture = null;
    this.capturePids = [];
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
    const child = this.spawnProcess(this.helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.capture = child;
    this.capturePids = [...processIds];
    this.lastAttachAt = this.now();
    const parse = createNdjsonParser(
      (message) => this.handleHelperMessage(child, message),
      (line) => this.onDebug?.("native listener emitted invalid JSON", line),
    );
    child.stdout.on("data", parse);
    child.stderr.on("data", (chunk) => this.onDebug?.("native listener stderr", chunk.toString()));
    child.once("error", (error) => {
      if (this.capture !== child) return;
      this.capture = null;
      this.capturePids = [];
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
    if (message.type === "ready") {
      this.reportStatus({
        available: true,
        capturing: true,
        monitoring: true,
        source: message.source || "Supported voice app",
      });
      return;
    }
    if (message.type === "error") {
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: true,
        source: null,
        error: String(message.message || "Native listener failed."),
      });
      return;
    }
    if (message.type !== "level" || !Number.isFinite(message.level)) return;

    const level = Math.max(0, Math.min(1, Number(message.level)));
    if (level > 0.008) {
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
      child.kill();
    }
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
  REATTACH_COOLDOWN_MS,
  SESSION_IDLE_MS,
  createNdjsonParser,
  helperExecutableName,
  resolveNativeHelperPath,
};
