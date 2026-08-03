"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");

const DEFAULT_AUDIO_CHUNK_MS = 100;
const DEFAULT_AVATAR_NAME = "20250408/sample_data";
const DEFAULT_END_GRACE_MS = 180;
const DEFAULT_FPS = 25;
const DEFAULT_HEIGHT = 960;
const DEFAULT_SAMPLE_RATE = 24_000;
const DEFAULT_SILENCE_TIMEOUT_MS = 20_000;
const DEFAULT_WIDTH = 448;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PROTOCOL_LINE_CHARS = Math.ceil(MAX_FRAME_BYTES / 3) * 4 + 4096;
const SPEECH_ID_PATTERN = /^\d+:\d+$/;

function boundedNumber(value, fallback, minimum, maximum) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function defaultRuntimeCandidates({
  explicitRoot = null,
  homeDirectory = os.homedir(),
  resourcesPath = process.resourcesPath,
} = {}) {
  return [
    explicitRoot,
    process.env.PERSONA_LITEAVATAR_RUNTIME,
    resourcesPath ? path.join(resourcesPath, "liteavatar-runtime") : null,
    path.join(
      homeDirectory,
      "Claude",
      "Projects",
      "macos-local-voice-agents",
      "server",
      "avatar-spike",
    ),
  ].filter((candidate, index, candidates) =>
    candidate && candidates.indexOf(candidate) === index,
  );
}

function runtimePaths(root) {
  const runtimeRoot = path.resolve(root);
  const oacDirectory = path.join(runtimeRoot, "vendor", "OpenAvatarChat");
  return {
    oacDirectory,
    pythonPath: path.join(runtimeRoot, ".venv-avatar", "bin", "python"),
    runtimeRoot,
    weightPath: path.join(
      oacDirectory,
      "src",
      "handlers",
      "avatar",
      "liteavatar",
      "algo",
      "liteavatar",
      "weights",
      "model_1.onnx",
    ),
  };
}

function resolveLiteAvatarRuntime({
  candidates = defaultRuntimeCandidates(),
  existsSync = fs.existsSync,
} = {}) {
  for (const candidate of candidates) {
    const resolved = runtimePaths(candidate);
    if (
      existsSync(resolved.pythonPath) &&
      existsSync(resolved.oacDirectory) &&
      existsSync(resolved.weightPath)
    ) {
      return { ...resolved, available: true };
    }
  }
  return {
    ...(candidates[0] ? runtimePaths(candidates[0]) : {}),
    available: false,
  };
}

function resolveLiteAvatarWorkerPath({
  isPackaged = false,
  projectRoot = path.join(__dirname, ".."),
  resourcesPath = process.resourcesPath,
} = {}) {
  return isPackaged
    ? path.join(resourcesPath, "native", "liteavatar", "worker.py")
    : path.join(projectRoot, "native", "liteavatar", "worker.py");
}

function createProtocolParser({
  maxLineChars = MAX_PROTOCOL_LINE_CHARS,
  onInvalid = () => {},
  onMessage,
}) {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString("utf8");
    if (pending.length > maxLineChars && !pending.includes("\n")) {
      onInvalid({ reason: "line-too-large", size: pending.length });
      pending = "";
      return;
    }
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > maxLineChars) {
        onInvalid({ reason: "line-too-large", size: line.length });
        continue;
      }
      try {
        onMessage(JSON.parse(line));
      } catch {
        onInvalid({ reason: "invalid-json", size: line.length });
      }
    }
  };
}

class Pcm16Resampler {
  constructor(targetRate = DEFAULT_SAMPLE_RATE) {
    this.targetRate = targetRate;
    this.sourceRate = null;
    this.remainder = 0;
  }

  reset(sourceRate = null) {
    this.sourceRate = sourceRate;
    this.remainder = 0;
  }

  process(data, sourceRate) {
    if (!Buffer.isBuffer(data) || data.length < 2) return Buffer.alloc(0);
    const sampleCount = Math.floor(data.length / 2);
    if (sourceRate === this.targetRate) return Buffer.from(data.subarray(0, sampleCount * 2));
    if (this.sourceRate !== sourceRate) this.reset(sourceRate);

    const numerator = this.remainder + sampleCount * this.targetRate;
    const outputCount = Math.floor(numerator / sourceRate);
    this.remainder = numerator % sourceRate;
    if (outputCount === 0) return Buffer.alloc(0);

    const output = Buffer.allocUnsafe(outputCount * 2);
    for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
      const sourcePosition = Math.max(
        0,
        Math.min(
          sampleCount - 1,
          ((outputIndex + 0.5) * sampleCount) / outputCount - 0.5,
        ),
      );
      const leftIndex = Math.floor(sourcePosition);
      const rightIndex = Math.min(sampleCount - 1, leftIndex + 1);
      const fraction = sourcePosition - leftIndex;
      const left = data.readInt16LE(leftIndex * 2);
      const right = data.readInt16LE(rightIndex * 2);
      const sample = Math.round(left + (right - left) * fraction);
      output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), outputIndex * 2);
    }
    return output;
  }
}

function validJpeg(data) {
  return (
    Buffer.isBuffer(data) &&
    data.length >= 4 &&
    data.length <= MAX_FRAME_BYTES &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data.at(-2) === 0xff &&
    data.at(-1) === 0xd9
  );
}

function publicError(error) {
  if (!error) return null;
  const message = String(error).replace(/\s+/g, " ").trim();
  return message.split(os.homedir()).join("~").slice(0, 240);
}

class LiteAvatarAdapter extends EventEmitter {
  constructor({
    audioChunkMs = DEFAULT_AUDIO_CHUNK_MS,
    avatarName = process.env.PERSONA_LITEAVATAR_NAME || DEFAULT_AVATAR_NAME,
    device = process.env.PERSONA_LITEAVATAR_DEVICE || "mps",
    endGraceMs = DEFAULT_END_GRACE_MS,
    existsSync = fs.existsSync,
    fps = boundedNumber(process.env.PERSONA_LITEAVATAR_FPS, DEFAULT_FPS, 5, 60),
    height = boundedNumber(
      process.env.PERSONA_LITEAVATAR_HEIGHT,
      DEFAULT_HEIGHT,
      128,
      1920,
    ),
    initTimeoutMs = boundedNumber(
      process.env.PERSONA_LITEAVATAR_INIT_TIMEOUT_MS,
      180_000,
      1_000,
      600_000,
    ),
    maxRestarts = 1,
    onDebug = () => {},
    onFrame = () => {},
    onStatus = () => {},
    restartDelayMs = 1_000,
    runtime = resolveLiteAvatarRuntime({ existsSync }),
    sampleRate = DEFAULT_SAMPLE_RATE,
    silenceTimeoutMs = DEFAULT_SILENCE_TIMEOUT_MS,
    spawnProcess = spawn,
    workerPath = resolveLiteAvatarWorkerPath(),
    width = boundedNumber(
      process.env.PERSONA_LITEAVATAR_WIDTH,
      DEFAULT_WIDTH,
      128,
      1920,
    ),
  } = {}) {
    super();
    this.audioChunkMs = audioChunkMs;
    this.avatarName = avatarName;
    this.device = device;
    this.endGraceMs = endGraceMs;
    this.existsSync = existsSync;
    this.fps = Math.round(fps);
    this.height = Math.round(height);
    this.initTimeoutMs = initTimeoutMs;
    this.maxRestarts = maxRestarts;
    this.onDebug = onDebug;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.restartDelayMs = restartDelayMs;
    this.runtime = runtime;
    this.sampleRate = sampleRate;
    this.silenceTimeoutMs = silenceTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.workerPath = workerPath;
    this.width = Math.round(width);

    this.child = null;
    this.phase = "off";
    this.lastError = null;
    this.heartbeat = null;
    this.currentFrame = null;
    this.frameSequence = 0;
    this.frames = 0;
    this.speechFrames = 0;
    this.invalidMessages = 0;
    this.staleFrames = 0;
    this.audioInputBytes = 0;
    this.audioSentBytes = 0;
    this.audioDroppedBeforeReady = 0;
    this.audioDroppedOutsideSpeech = 0;
    this.restartCount = 0;
    this.epoch = 0;
    this.utterance = 0;
    this.speaking = false;
    this.pendingAudio = Buffer.alloc(0);
    this.resampler = new Pcm16Resampler(sampleRate);
    this.startupTimer = null;
    this.restartTimer = null;
    this.silenceTimer = null;
    this.endTimer = null;
    this.stopping = false;
    this.generation = 0;
    this.recoveringGeneration = null;
  }

  debug(...details) {
    try {
      this.onDebug(...details);
    } catch {
      // Diagnostics must never affect the avatar or voice data plane.
    }
  }

  notifyStatus() {
    const status = this.getStatus();
    try {
      this.onStatus(status);
    } catch {
      // Renderer diagnostics are best effort.
    }
    this.emit("status", status);
  }

  getStatus() {
    return {
      audioDroppedBeforeReady: this.audioDroppedBeforeReady,
      audioDroppedOutsideSpeech: this.audioDroppedOutsideSpeech,
      audioInputBytes: this.audioInputBytes,
      audioSentBytes: this.audioSentBytes,
      avatarName: this.avatarName,
      device: this.device,
      error: publicError(this.lastError),
      fps: this.heartbeat?.fps ?? null,
      frameSequence: this.frameSequence,
      frames: this.frames,
      height: this.height,
      invalidMessages: this.invalidMessages,
      loadSeconds: this.heartbeat?.load_s ?? null,
      phase: this.phase,
      processId: this.child?.pid ?? null,
      restartCount: this.restartCount,
      rssMb: this.heartbeat?.rss_mb ?? null,
      runtimeAvailable: this.runtime.available === true,
      sampleRate: this.sampleRate,
      speechFrames: this.speechFrames,
      staleFrames: this.staleFrames,
      swapDeltaMb: this.heartbeat?.swap_delta_mb ?? null,
      systemFreeMb: this.heartbeat?.sys_free_mb ?? null,
      width: this.width,
    };
  }

  getFrame() {
    return this.currentFrame;
  }

  start() {
    if (["starting", "ready"].includes(this.phase)) return;
    this.stopping = false;
    this.restartCount = 0;
    this.recoveringGeneration = null;
    this.phase = "starting";
    this.lastError = null;
    this.notifyStatus();
    this.launch();
  }

  launch() {
    if (this.stopping) return;
    if (!this.runtime.available) {
      this.fail("LiteAvatar runtime is incomplete; Python, OpenAvatarChat, or model weights are missing.");
      return;
    }
    if (!this.existsSync(this.workerPath)) {
      this.fail("Persona's LiteAvatar worker is missing.");
      return;
    }

    const generation = ++this.generation;
    this.recoveringGeneration = null;
    try {
      const child = this.spawnProcess(
        this.runtime.pythonPath,
        [this.workerPath],
        {
          cwd: this.runtime.runtimeRoot,
          env: {
            ...process.env,
            P0_AVATAR_ORT_THREADS:
              process.env.PERSONA_LITEAVATAR_ORT_THREADS || "2",
            P0_AVATAR_THREADS:
              process.env.PERSONA_LITEAVATAR_THREADS || "2",
            P0_AVATAR_TORCH_DEVICE: this.device,
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      this.child = child;
      const parse = createProtocolParser({
        onInvalid: (detail) => {
          this.invalidMessages += 1;
          this.debug("LiteAvatar protocol message rejected", detail);
        },
        onMessage: (message) => this.handleWorkerMessage(generation, message),
      });
      child.stdout.on("data", parse);
      child.stderr.on("data", (chunk) => {
        const line = chunk.toString("utf8").trim().slice(-1000);
        if (line) this.debug("LiteAvatar worker", line);
      });
      child.once("error", (error) => this.handleWorkerFailure(generation, error));
      child.once("exit", (code, signal) => {
        this.handleWorkerExit(generation, code, signal);
      });
      this.startupTimer = setTimeout(() => {
        if (generation !== this.generation || this.phase !== "starting") return;
        this.handleWorkerFailure(
          generation,
          new Error(
            `LiteAvatar initialization exceeded ${Math.round(this.initTimeoutMs / 1000)} seconds.`,
          ),
        );
      }, this.initTimeoutMs);
      this.startupTimer.unref?.();
      void this.writeCommand(
        {
          audio_sr: this.sampleRate,
          avatar_name: this.avatarName,
          cmd: "init",
          emit_audio: false,
          fast: true,
          fps: this.fps,
          h: this.height,
          oac_dir: this.runtime.oacDirectory,
          use_gpu: false,
          w: this.width,
        },
        { allowStarting: true, child },
      ).catch((error) => this.handleWorkerFailure(generation, error));
    } catch (error) {
      this.handleWorkerFailure(generation, error);
    }
  }

  handleWorkerMessage(generation, message) {
    if (generation !== this.generation || message == null || typeof message !== "object") return;
    if (this.phase === "ready") this.armSilenceWatchdog(generation);
    if (message.ok === true && this.phase === "starting") {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.phase = "ready";
      this.lastError = null;
      this.heartbeat = {
        ...(this.heartbeat ?? {}),
        load_s: boundedNumber(message.load_s, null, 0, 3600),
      };
      this.armSilenceWatchdog(generation);
      this.notifyStatus();
      return;
    }
    if (message.t === "v") {
      this.handleVideoMessage(message);
      return;
    }
    if (message.t === "hb") {
      this.heartbeat = {
        fps: boundedNumber(message.fps, null, 0, 240),
        load_s: this.heartbeat?.load_s ?? null,
        rss_mb: boundedNumber(message.rss_mb, null, 0, 64 * 1024),
        swap_delta_mb: boundedNumber(message.swap_delta_mb, null, -64 * 1024, 64 * 1024),
        sys_free_mb: boundedNumber(message.sys_free_mb, null, 0, 1024 * 1024),
      };
      this.notifyStatus();
      return;
    }
    if (message.error) {
      const error = publicError(message.error) || "LiteAvatar worker error.";
      this.debug("LiteAvatar worker error", error);
      this.handleWorkerFailure(generation, new Error(error));
    }
  }

  armSilenceWatchdog(generation) {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (generation !== this.generation || this.phase !== "ready") return;
      this.handleWorkerFailure(
        generation,
        new Error(
          `LiteAvatar worker produced no frames or heartbeat for ${Math.round(this.silenceTimeoutMs / 1000)} seconds.`,
        ),
      );
    }, this.silenceTimeoutMs);
    this.silenceTimer.unref?.();
  }

  handleVideoMessage(message) {
    const sid = typeof message.sid === "string" ? message.sid : "";
    if (sid && (sid.length > 64 || !SPEECH_ID_PATTERN.test(sid))) {
      this.invalidMessages += 1;
      return;
    }
    const stale = this.isStale(sid);
    if (this.phase !== "ready" || stale) {
      if (stale) this.staleFrames += 1;
      return;
    }
    if (typeof message.jpg !== "string" || message.jpg.length > MAX_PROTOCOL_LINE_CHARS) {
      this.invalidMessages += 1;
      return;
    }
    const jpeg = Buffer.from(message.jpg, "base64");
    if (!validJpeg(jpeg)) {
      this.invalidMessages += 1;
      return;
    }
    this.frameSequence += 1;
    this.frames += 1;
    if (sid) this.speechFrames += 1;
    this.currentFrame = {
      jpeg,
      receivedAt: Date.now(),
      sequence: this.frameSequence,
      sid,
    };
    const metadata = {
      height: this.height,
      sequence: this.frameSequence,
      sid,
      width: this.width,
    };
    try {
      this.onFrame(metadata);
    } catch {
      // Rendering cannot break worker processing.
    }
    this.emit("frame", metadata);
  }

  isStale(sid) {
    if (typeof sid !== "string" || !sid.includes(":")) return false;
    const epoch = Number(sid.split(":", 1)[0]);
    return Number.isInteger(epoch) && epoch !== this.epoch;
  }

  handleWorkerFailure(generation, error) {
    if (generation !== this.generation || this.stopping) return;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.handleUnexpectedStop(generation);
  }

  handleWorkerExit(generation, code, signal) {
    if (generation !== this.generation) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.child = null;
    if (this.stopping || this.phase === "stopped") return;
    this.lastError = `LiteAvatar worker exited${code == null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
    this.handleUnexpectedStop(generation);
  }

  handleUnexpectedStop(generation) {
    if (generation !== this.generation || this.recoveringGeneration === generation) {
      return;
    }
    this.recoveringGeneration = generation;
    clearTimeout(this.startupTimer);
    clearTimeout(this.silenceTimer);
    clearTimeout(this.endTimer);
    this.startupTimer = null;
    this.silenceTimer = null;
    this.endTimer = null;
    this.epoch += 1;
    this.pendingAudio = Buffer.alloc(0);
    this.resampler.reset();
    const child = this.child;
    this.child = null;
    this.generation += 1;
    this.terminateChild(child);
    if (this.restartCount < this.maxRestarts) {
      this.restartCount += 1;
      this.phase = "starting";
      this.notifyStatus();
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(
        () => this.launch(),
        this.restartDelayMs * this.restartCount,
      );
      this.restartTimer.unref?.();
      return;
    }
    this.fail(this.lastError || "LiteAvatar worker stopped.");
  }

  fail(error) {
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.phase = "failed";
    this.lastError = error instanceof Error ? error.message : String(error);
    this.notifyStatus();
  }

  async writeCommand(command, { allowStarting = false, child = this.child } = {}) {
    if (
      !child ||
      child !== this.child ||
      !child.stdin ||
      child.stdin.destroyed ||
      (!allowStarting && this.phase !== "ready")
    ) {
      return false;
    }
    const line = `${JSON.stringify(command)}\n`;
    await new Promise((resolve, reject) => {
      child.stdin.write(line, "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return true;
  }

  appendPendingAudio(data) {
    if (data.length === 0) return;
    this.pendingAudio =
      this.pendingAudio.length === 0
        ? data
        : Buffer.concat([this.pendingAudio, data]);
  }

  takePendingAudio(byteCount) {
    const output = Buffer.from(this.pendingAudio.subarray(0, byteCount));
    this.pendingAudio = Buffer.from(this.pendingAudio.subarray(byteCount));
    return output;
  }

  speechId() {
    if (this.utterance === 0) this.utterance = 1;
    return `${this.epoch}:${this.utterance}`;
  }

  async sendAudio(data, end = false) {
    if (data.length === 0 && !end) return;
    const sent = await this.writeCommand({
      chunk: data.toString("base64"),
      cmd: "audio",
      end,
      sid: this.speechId(),
    });
    if (sent) this.audioSentBytes += data.length;
  }

  async handlePcm(frame) {
    this.audioInputBytes += frame.data.length;
    if (this.phase !== "ready") {
      this.audioDroppedBeforeReady += 1;
      return;
    }
    if (!this.speaking && this.endTimer == null) {
      this.audioDroppedOutsideSpeech += 1;
      return;
    }
    const converted = this.resampler.process(frame.data, frame.sampleRate);
    this.appendPendingAudio(converted);
    const targetBytes = Math.max(
      2,
      Math.round((this.sampleRate * this.audioChunkMs) / 1000) * 2,
    );
    while (this.pendingAudio.length >= targetBytes) {
      await this.sendAudio(this.takePendingAudio(targetBytes), false);
    }
  }

  handleEvent(event) {
    if (event.type !== "state") return;
    const nowSpeaking =
      event.state.phase === "active" &&
      event.state.activity === "speaking" &&
      !event.state.outputMuted;
    if (nowSpeaking && !this.speaking) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
      this.utterance += 1;
      this.speaking = true;
    } else if (!nowSpeaking && this.speaking) {
      this.speaking = false;
      this.scheduleFinishUtterance();
    }
    if (["inactive", "stopping"].includes(event.state.phase)) {
      this.interrupt();
    }
  }

  scheduleFinishUtterance() {
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      void this.finishUtterance().catch((error) => {
        this.debug("LiteAvatar end-of-speech failed", publicError(error));
      });
    }, this.endGraceMs);
    this.endTimer.unref?.();
  }

  async finishUtterance() {
    if (this.phase !== "ready") return;
    const pending = this.takePendingAudio(this.pendingAudio.length);
    this.resampler.reset();
    await this.sendAudio(pending, true);
  }

  interrupt() {
    clearTimeout(this.endTimer);
    this.endTimer = null;
    this.epoch += 1;
    this.pendingAudio = Buffer.alloc(0);
    this.resampler.reset();
    if (this.phase === "ready") {
      void this.writeCommand({ cmd: "interrupt" }).catch((error) => {
        this.debug("LiteAvatar interrupt failed", publicError(error));
      });
    }
  }

  waitUntilReady(timeoutMs = this.initTimeoutMs + 1000) {
    if (this.phase === "ready") return Promise.resolve(this.getStatus());
    if (this.phase === "failed") return Promise.reject(new Error(this.lastError));
    if (this.phase === "stopped") {
      return Promise.reject(new Error("LiteAvatar is stopped."));
    }
    return new Promise((resolve, reject) => {
      const onStatus = (status) => {
        if (status.phase === "ready") finish(resolve, status);
        else if (status.phase === "failed") {
          finish(reject, new Error(status.error || "LiteAvatar failed."));
        }
      };
      const finish = (callback, value) => {
        clearTimeout(timer);
        this.off("status", onStatus);
        callback(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error("Timed out waiting for LiteAvatar.")),
        timeoutMs,
      );
      timer.unref?.();
      this.on("status", onStatus);
    });
  }

  waitForFrame({ afterSequence = 0, speechOnly = false, timeoutMs = 30_000 } = {}) {
    const current = this.currentFrame;
    if (
      current?.sequence > afterSequence &&
      (!speechOnly || Boolean(current.sid))
    ) {
      return Promise.resolve(current);
    }
    return new Promise((resolve, reject) => {
      const onFrame = (metadata) => {
        if (
          metadata.sequence > afterSequence &&
          (!speechOnly || Boolean(metadata.sid))
        ) {
          finish(resolve, this.currentFrame);
        }
      };
      const finish = (callback, value) => {
        clearTimeout(timer);
        this.off("frame", onFrame);
        this.off("status", onStatus);
        callback(value);
      };
      const onStatus = (status) => {
        if (["failed", "stopped"].includes(status.phase)) {
          finish(
            reject,
            new Error(status.error || `LiteAvatar is ${status.phase}.`),
          );
        }
      };
      const timer = setTimeout(
        () => finish(reject, new Error("Timed out waiting for a LiteAvatar frame.")),
        timeoutMs,
      );
      timer.unref?.();
      this.on("frame", onFrame);
      this.on("status", onStatus);
    });
  }

  terminateChild(child = this.child) {
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may already have exited.
    }
  }

  async stop() {
    if (this.phase === "stopped") return;
    this.stopping = true;
    clearTimeout(this.startupTimer);
    clearTimeout(this.restartTimer);
    clearTimeout(this.silenceTimer);
    clearTimeout(this.endTimer);
    this.startupTimer = null;
    this.restartTimer = null;
    this.silenceTimer = null;
    this.endTimer = null;
    const child = this.child;
    this.phase = "stopped";
    this.notifyStatus();
    if (!child) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await this.writeCommand({ cmd: "stop" }, { allowStarting: true, child });
      child.stdin.end();
    } catch {
      // Termination below is the fallback.
    }
    let cleanTimer;
    const cleanExit = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        cleanTimer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
    clearTimeout(cleanTimer);
    if (!cleanExit) {
      this.terminateChild(child);
      let forceTimer;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          forceTimer = setTimeout(resolve, 500);
        }),
      ]);
      clearTimeout(forceTimer);
    }
    if (this.child === child) this.child = null;
  }
}

function createLiteAvatarFrameResponse(adapter, rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "persona-avatar:" || url.hostname !== "frame") {
      return new Response("Not found", { status: 404 });
    }
    const sequence = Number(url.pathname.replace(/^\/+/, ""));
    const frame = adapter?.getFrame();
    if (
      !frame ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0 ||
      sequence > frame.sequence
    ) {
      return new Response("Frame unavailable", { status: 404 });
    }
    return new Response(new Uint8Array(frame.jpeg), {
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "image/jpeg",
        "x-persona-frame-sequence": String(frame.sequence),
      },
      status: 200,
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

module.exports = {
  DEFAULT_AVATAR_NAME,
  DEFAULT_END_GRACE_MS,
  DEFAULT_FPS,
  DEFAULT_HEIGHT,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_SILENCE_TIMEOUT_MS,
  DEFAULT_WIDTH,
  LiteAvatarAdapter,
  MAX_FRAME_BYTES,
  Pcm16Resampler,
  createLiteAvatarFrameResponse,
  createProtocolParser,
  defaultRuntimeCandidates,
  resolveLiteAvatarRuntime,
  resolveLiteAvatarWorkerPath,
  runtimePaths,
  validJpeg,
};
