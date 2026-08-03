"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  AVATAR_DRIVER_API_VERSION,
  DEFAULT_AVATAR_DRIVER_ID,
  LITEAVATAR_DRIVER_ID,
  PcmDispatchQueue,
  REALISTIC_PCM_SPIKE_DRIVER_ID,
  S4B_DRIVER_ID,
  createAvatarDriverHost,
  resolveAvatarDriver,
} = require("./avatar-driver.cjs");

function pcmFrame(sequence, bytes = 8) {
  return {
    channels: 1,
    data: Buffer.alloc(bytes, sequence),
    encoding: "s16le",
    frames: bytes / 2,
    sampleRate: 48_000,
    sequence,
  };
}

function stateEvent(activity = "speaking") {
  return {
    type: "state",
    state: {
      activity,
      microphoneMuted: false,
      outputMuted: false,
      phase: "active",
    },
  };
}

test("Avatar Driver v1 defaults to VRM and safely falls back from unknown ids", () => {
  assert.equal(resolveAvatarDriver().driver.id, DEFAULT_AVATAR_DRIVER_ID);
  const resolved = resolveAvatarDriver("future-driver");
  assert.equal(resolved.driver.id, DEFAULT_AVATAR_DRIVER_ID);
  assert.equal(resolved.requestedId, "future-driver");
  assert.match(resolved.fallbackReason, /using vrm/i);
});

test("VRM driver preserves the state, level, and animation event contract", () => {
  const rendered = [];
  const driver = createAvatarDriverHost({
    onRendererEvent: (event) => rendered.push(event),
  });
  const events = [
    stateEvent(),
    { type: "audio-level", level: 0.4 },
    { type: "animation", animation: "CUSTOM", animationName: "wave" },
  ];

  for (const event of events) assert.equal(driver.handleEvent(event), true);

  assert.deepEqual(rendered, events);
  assert.equal(driver.apiVersion, AVATAR_DRIVER_API_VERSION);
  assert.equal(driver.requiresPcm, false);
  assert.deepEqual(driver.getStatus().events, {
    accepted: 3,
    adapterErrors: 0,
    animation: 1,
    audioLevel: 1,
    rejected: 0,
    rendererErrors: 0,
    state: 1,
  });
});

test("Avatar Driver v1 rejects events outside its narrow contract", () => {
  const rendered = [];
  const driver = createAvatarDriverHost({
    onRendererEvent: (event) => rendered.push(event),
  });

  assert.equal(driver.handleEvent({ type: "audio-level", level: 2 }), false);
  assert.equal(driver.handleEvent({ type: "listener-status" }), false);
  assert.equal(driver.handleEvent(null), false);
  assert.deepEqual(rendered, []);
  assert.equal(driver.getStatus().events.rejected, 3);
});

test("PCM queue drops stale queued audio instead of blocking a slow driver", async () => {
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const delivered = [];
  const queue = new PcmDispatchQueue({
    maxBytes: 16,
    maxChunks: 2,
    sink: async (frame) => {
      delivered.push(frame.sequence);
      if (frame.sequence === 1) await firstBlocked;
    },
  });

  assert.equal(queue.enqueue(pcmFrame(1)), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.enqueue(pcmFrame(2)), true);
  assert.equal(queue.enqueue(pcmFrame(3)), true);
  assert.equal(queue.enqueue(pcmFrame(4)), true);
  assert.deepEqual(delivered, [1]);
  assert.equal(queue.getStats().droppedChunks, 2);

  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(delivered, [1, 4]);
  assert.equal(queue.getStats().deliveredChunks, 2);
  await queue.close();
});

test("realistic PCM spike is opt-in and never sends PCM to the renderer", async () => {
  const rendered = [];
  const pcm = [];
  const driver = createAvatarDriverHost({
    driverId: REALISTIC_PCM_SPIKE_DRIVER_ID,
    onRendererEvent: (event) => rendered.push(event),
    pcmSink: (frame) => pcm.push(frame.sequence),
  });

  driver.handleEvent(stateEvent("thinking"));
  assert.equal(driver.handlePcm(pcmFrame(7)), true);
  assert.equal(
    driver.handlePcm({ ...pcmFrame(8), channels: 2 }),
    false,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(driver.requiresPcm, true);
  assert.equal(driver.getStatus().capabilities.surface, "vrm-fallback");
  assert.equal(driver.getStatus().pcm.deliveredChunks, 1);
  assert.equal(driver.getStatus().pcm.rejectedChunks, 1);
  assert.deepEqual(rendered, [stateEvent("thinking")]);
  assert.deepEqual(pcm, [7]);
  assert.equal("data" in rendered[0], false);
  await driver.stop();
});

test("LiteAvatar driver owns adapter lifecycle while retaining renderer fallback events", async () => {
  const calls = [];
  const rendered = [];
  const adapter = {
    getStatus: () => ({ phase: "ready" }),
    handleEvent: (event) => calls.push(["event", event.type]),
    handlePcm: async (frame) => calls.push(["pcm", frame.sequence]),
    start: () => calls.push(["start"]),
    stop: async () => calls.push(["stop"]),
  };
  const driver = createAvatarDriverHost({
    adapter,
    driverId: LITEAVATAR_DRIVER_ID,
    onRendererEvent: (event) => rendered.push(event),
  });

  assert.equal(driver.start(), true);
  assert.equal(driver.handleEvent(stateEvent("speaking")), true);
  assert.equal(driver.handlePcm(pcmFrame(11)), true);
  await driver.flushPcm();

  assert.equal(driver.id, LITEAVATAR_DRIVER_ID);
  assert.equal(driver.getStatus().capabilities.surface, "liteavatar");
  assert.deepEqual(driver.getStatus().adapter, { phase: "ready" });
  assert.deepEqual(rendered, [stateEvent("speaking")]);
  assert.deepEqual(calls, [
    ["start"],
    ["event", "state"],
    ["pcm", 11],
  ]);

  await driver.stop();
  assert.deepEqual(calls.at(-1), ["stop"]);
});

test("S4b driver owns a state-pack adapter without requesting PCM", async () => {
  const calls = [];
  const rendered = [];
  const adapter = {
    getStatus: () => ({ phase: "ready", surface: "s4b" }),
    start: () => calls.push(["start"]),
    stop: () => calls.push(["stop"]),
  };
  const driver = createAvatarDriverHost({
    adapter,
    driverId: S4B_DRIVER_ID,
    onRendererEvent: (event) => rendered.push(event),
  });

  assert.equal(driver.start(), true);
  assert.equal(driver.handleEvent(stateEvent("thinking")), true);
  assert.equal(driver.handleEvent({ type: "audio-level", level: 0.5 }), true);
  assert.equal(driver.handlePcm(pcmFrame(1)), false);
  assert.equal(driver.requiresPcm, false);
  assert.equal(driver.getStatus().capabilities.surface, "s4b");
  assert.deepEqual(rendered, [
    stateEvent("thinking"),
    { type: "audio-level", level: 0.5 },
  ]);

  await driver.stop();
  assert.deepEqual(calls, [["start"], ["stop"]]);
});
