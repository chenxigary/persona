"use strict";

const { S4B_DRIVER_ID } = require("./s4b-pack.cjs");

const AVATAR_DRIVER_API_VERSION = 1;
const DEFAULT_AVATAR_DRIVER_ID = "vrm";
const LITEAVATAR_DRIVER_ID = "liteavatar";
const REALISTIC_PCM_SPIKE_DRIVER_ID = "realistic-pcm-spike";
const DEFAULT_PCM_QUEUE_BYTES = 256 * 1024;
const DEFAULT_PCM_QUEUE_CHUNKS = 24;
const MAX_PCM_FRAME_BYTES = 16 * 1024;

const AVATAR_DRIVER_DEFINITIONS = Object.freeze({
  [DEFAULT_AVATAR_DRIVER_ID]: Object.freeze({
    capabilities: Object.freeze({
      animation: true,
      audioLevel: true,
      pcm: false,
      state: true,
      surface: "vrm",
    }),
    experimental: false,
    id: DEFAULT_AVATAR_DRIVER_ID,
  }),
  [REALISTIC_PCM_SPIKE_DRIVER_ID]: Object.freeze({
    capabilities: Object.freeze({
      animation: true,
      audioLevel: true,
      pcm: true,
      state: true,
      // v1 proves the input plane while retaining the current visual output.
      // A later adapter can replace this with a video or texture surface.
      surface: "vrm-fallback",
    }),
    experimental: true,
    id: REALISTIC_PCM_SPIKE_DRIVER_ID,
  }),
  [LITEAVATAR_DRIVER_ID]: Object.freeze({
    capabilities: Object.freeze({
      animation: false,
      audioLevel: false,
      pcm: true,
      state: true,
      surface: "liteavatar",
    }),
    experimental: true,
    id: LITEAVATAR_DRIVER_ID,
  }),
  [S4B_DRIVER_ID]: Object.freeze({
    capabilities: Object.freeze({
      animation: false,
      audioLevel: true,
      pcm: false,
      state: true,
      surface: "s4b",
    }),
    experimental: true,
    id: S4B_DRIVER_ID,
  }),
});

function normalizeDriverRequest(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return DEFAULT_AVATAR_DRIVER_ID;
  }
  return value.trim().toLowerCase().slice(0, 64);
}

function resolveAvatarDriver(value) {
  const requestedId = normalizeDriverRequest(value);
  const driver = AVATAR_DRIVER_DEFINITIONS[requestedId];
  if (driver) return { driver, fallbackReason: null, requestedId };
  return {
    driver: AVATAR_DRIVER_DEFINITIONS[DEFAULT_AVATAR_DRIVER_ID],
    fallbackReason: `Unknown avatar driver "${requestedId}"; using vrm.`,
    requestedId,
  };
}

function isAvatarDriverEvent(event) {
  if (event == null || typeof event !== "object") return false;
  if (event.type === "audio-level") {
    return Number.isFinite(event.level) && event.level >= 0 && event.level <= 1;
  }
  if (event.type === "state") {
    return (
      event.state != null &&
      typeof event.state === "object" &&
      ["inactive", "starting", "active", "stopping"].includes(
        event.state.phase,
      ) &&
      ["idle", "listening", "thinking", "speaking"].includes(
        event.state.activity,
      ) &&
      typeof event.state.microphoneMuted === "boolean" &&
      typeof event.state.outputMuted === "boolean"
    );
  }
  if (event.type === "animation") {
    return typeof event.animation === "string" && event.animation.length > 0;
  }
  return false;
}

function pcmFrameBytes(frame) {
  return Buffer.isBuffer(frame?.data) ? frame.data.length : 0;
}

function isAvatarPcmFrame(frame) {
  const bytes = pcmFrameBytes(frame);
  return (
    frame != null &&
    typeof frame === "object" &&
    frame.encoding === "s16le" &&
    frame.channels === 1 &&
    Number.isFinite(frame.sampleRate) &&
    frame.sampleRate >= 8_000 &&
    frame.sampleRate <= 192_000 &&
    Number.isSafeInteger(frame.sequence) &&
    frame.sequence >= 0 &&
    bytes > 0 &&
    bytes <= MAX_PCM_FRAME_BYTES &&
    bytes % 2 === 0 &&
    frame.frames === bytes / 2
  );
}

class PcmDispatchQueue {
  constructor({
    maxBytes = DEFAULT_PCM_QUEUE_BYTES,
    maxChunks = DEFAULT_PCM_QUEUE_CHUNKS,
    onError = () => {},
    sink = () => {},
  } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new TypeError("maxBytes must be a positive integer.");
    }
    if (!Number.isInteger(maxChunks) || maxChunks <= 0) {
      throw new TypeError("maxChunks must be a positive integer.");
    }
    if (typeof sink !== "function") {
      throw new TypeError("sink must be a function.");
    }
    this.maxBytes = maxBytes;
    this.maxChunks = maxChunks;
    this.onError = onError;
    this.sink = sink;
    this.queue = [];
    this.queuedBytes = 0;
    this.inFlightBytes = 0;
    this.closed = false;
    this.drainPromise = null;
    this.stats = {
      deliveredBytes: 0,
      deliveredChunks: 0,
      droppedBytes: 0,
      droppedChunks: 0,
      failedBytes: 0,
      failedChunks: 0,
      lastError: null,
      lastSequence: null,
      receivedBytes: 0,
      receivedChunks: 0,
    };
  }

  drop(frame) {
    const bytes = pcmFrameBytes(frame);
    this.stats.droppedBytes += bytes;
    this.stats.droppedChunks += 1;
  }

  enqueue(frame) {
    const bytes = pcmFrameBytes(frame);
    if (this.closed || bytes <= 0) return false;

    this.stats.receivedBytes += bytes;
    this.stats.receivedChunks += 1;
    this.stats.lastSequence = frame.sequence ?? null;

    if (bytes > this.maxBytes) {
      this.drop(frame);
      return false;
    }

    while (
      this.queue.length > 0 &&
      (this.inFlightBytes + this.queuedBytes + bytes > this.maxBytes ||
        this.queue.length + (this.inFlightBytes > 0 ? 1 : 0) + 1 >
          this.maxChunks)
    ) {
      const stale = this.queue.shift();
      this.queuedBytes -= pcmFrameBytes(stale);
      this.drop(stale);
    }

    if (
      this.inFlightBytes + this.queuedBytes + bytes > this.maxBytes ||
      this.queue.length + (this.inFlightBytes > 0 ? 1 : 0) + 1 >
        this.maxChunks
    ) {
      this.drop(frame);
      return false;
    }

    this.queue.push(frame);
    this.queuedBytes += bytes;
    this.scheduleDrain();
    return true;
  }

  scheduleDrain() {
    if (this.drainPromise || this.closed) return;
    this.drainPromise = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.drainPromise = null;
        if (!this.closed && this.queue.length > 0) this.scheduleDrain();
      });
  }

  async drain() {
    while (!this.closed && this.queue.length > 0) {
      const frame = this.queue.shift();
      const bytes = pcmFrameBytes(frame);
      this.queuedBytes -= bytes;
      this.inFlightBytes = bytes;
      try {
        await this.sink(frame);
        this.stats.deliveredBytes += bytes;
        this.stats.deliveredChunks += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.stats.failedBytes += bytes;
        this.stats.failedChunks += 1;
        this.stats.lastError = message;
        try {
          this.onError(message);
        } catch {
          // Diagnostics must never break the PCM drain path.
        }
      } finally {
        this.inFlightBytes = 0;
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      closed: this.closed,
      inFlight: this.inFlightBytes > 0,
      maxBytes: this.maxBytes,
      maxChunks: this.maxChunks,
      queuedBytes: this.queuedBytes,
      queuedChunks: this.queue.length,
    };
  }

  async close() {
    if (this.closed) return this.drainPromise;
    this.closed = true;
    for (const frame of this.queue) this.drop(frame);
    this.queue = [];
    this.queuedBytes = 0;
    await this.drainPromise;
  }

  async waitForIdle() {
    while (this.drainPromise || this.queue.length > 0 || this.inFlightBytes > 0) {
      if (this.drainPromise) await this.drainPromise;
      else await new Promise((resolve) => setImmediate(resolve));
    }
    return this.getStats();
  }
}

function createAvatarDriverHost({
  adapter = null,
  driverId = DEFAULT_AVATAR_DRIVER_ID,
  maxPcmBytes = DEFAULT_PCM_QUEUE_BYTES,
  maxPcmChunks = DEFAULT_PCM_QUEUE_CHUNKS,
  onDebug = () => {},
  onRendererEvent = () => {},
  pcmSink = () => {},
} = {}) {
  const { driver, fallbackReason, requestedId } = resolveAvatarDriver(driverId);
  if (typeof onRendererEvent !== "function") {
    throw new TypeError("onRendererEvent must be a function.");
  }
  const reportDebug = (...details) => {
    if (typeof onDebug !== "function") return;
    try {
      onDebug(...details);
    } catch {
      // Diagnostics are observational and must not affect either data plane.
    }
  };
  const eventStats = {
    accepted: 0,
    adapterErrors: 0,
    animation: 0,
    audioLevel: 0,
    rejected: 0,
    rendererErrors: 0,
    state: 0,
  };
  let rejectedPcmChunks = 0;
  const activeAdapter =
    driver.id === LITEAVATAR_DRIVER_ID || driver.id === S4B_DRIVER_ID
      ? adapter
      : null;
  const sink = activeAdapter
    ? (frame) => activeAdapter.handlePcm(frame)
    : pcmSink;
  const pcmQueue = driver.capabilities.pcm
    ? new PcmDispatchQueue({
        maxBytes: maxPcmBytes,
        maxChunks: maxPcmChunks,
        onError: (message) => reportDebug("PCM sink failed", message),
        sink,
      })
    : null;

  function handleEvent(event) {
    if (!isAvatarDriverEvent(event)) {
      eventStats.rejected += 1;
      return false;
    }
    eventStats.accepted += 1;
    if (event.type === "state") eventStats.state += 1;
    else if (event.type === "audio-level") eventStats.audioLevel += 1;
    else eventStats.animation += 1;
    if (activeAdapter && typeof activeAdapter.handleEvent === "function") {
      try {
        activeAdapter.handleEvent(event);
      } catch (error) {
        eventStats.adapterErrors += 1;
        reportDebug(
          "adapter event failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    try {
      onRendererEvent(event);
      return true;
    } catch (error) {
      eventStats.rendererErrors += 1;
      reportDebug(
        "renderer event failed",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  return {
    apiVersion: AVATAR_DRIVER_API_VERSION,
    capabilities: driver.capabilities,
    id: driver.id,
    requiresPcm: driver.capabilities.pcm,
    start() {
      if (!activeAdapter || typeof activeAdapter.start !== "function") return false;
      try {
        activeAdapter.start();
        return true;
      } catch (error) {
        eventStats.adapterErrors += 1;
        reportDebug(
          "adapter start failed",
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    },
    getStatus() {
      return {
        adapter:
          activeAdapter && typeof activeAdapter.getStatus === "function"
            ? activeAdapter.getStatus()
            : null,
        apiVersion: AVATAR_DRIVER_API_VERSION,
        capabilities: { ...driver.capabilities },
        events: { ...eventStats },
        experimental: driver.experimental,
        fallbackReason,
        id: driver.id,
        pcm: pcmQueue
          ? {
              enabled: true,
              rejectedChunks: rejectedPcmChunks,
              ...pcmQueue.getStats(),
            }
          : { enabled: false },
        requestedId,
      };
    },
    handleEvent,
    handlePcm(frame) {
      if (!pcmQueue) return false;
      if (!isAvatarPcmFrame(frame)) {
        rejectedPcmChunks += 1;
        return false;
      }
      return pcmQueue.enqueue(frame);
    },
    flushPcm() {
      return pcmQueue?.waitForIdle() ?? Promise.resolve(null);
    },
    async stop() {
      await (pcmQueue?.close() ?? Promise.resolve());
      if (activeAdapter && typeof activeAdapter.stop === "function") {
        await activeAdapter.stop();
      }
    },
  };
}

module.exports = {
  AVATAR_DRIVER_API_VERSION,
  AVATAR_DRIVER_DEFINITIONS,
  DEFAULT_AVATAR_DRIVER_ID,
  DEFAULT_PCM_QUEUE_BYTES,
  DEFAULT_PCM_QUEUE_CHUNKS,
  LITEAVATAR_DRIVER_ID,
  MAX_PCM_FRAME_BYTES,
  PcmDispatchQueue,
  REALISTIC_PCM_SPIKE_DRIVER_ID,
  S4B_DRIVER_ID,
  createAvatarDriverHost,
  isAvatarDriverEvent,
  isAvatarPcmFrame,
  resolveAvatarDriver,
};
