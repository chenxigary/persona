"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { LiteAvatarAdapter } = require("./liteavatar-adapter.cjs");

function stateEvent(activity) {
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

test("LiteAvatar adapter speaks the JSON-lines protocol with an isolated sidecar", async () => {
  const projectRoot = path.join(__dirname, "..");
  const adapter = new LiteAvatarAdapter({
    endGraceMs: 1,
    existsSync: () => true,
    initTimeoutMs: 2_000,
    maxRestarts: 0,
    runtime: {
      available: true,
      oacDirectory: projectRoot,
      pythonPath: process.execPath,
      runtimeRoot: projectRoot,
      weightPath: path.join(projectRoot, "fake.onnx"),
    },
    silenceTimeoutMs: 2_000,
    workerPath: path.join(
      projectRoot,
      "scripts",
      "fixtures",
      "liteavatar-fake-worker.cjs",
    ),
  });

  try {
    adapter.start();
    await adapter.waitUntilReady();
    const idle = await adapter.waitForFrame();
    assert.equal(idle.sid, "");

    adapter.handleEvent(stateEvent("speaking"));
    await adapter.handlePcm({ data: Buffer.alloc(9600), sampleRate: 48_000 });
    const speech = await adapter.waitForFrame({
      afterSequence: idle.sequence,
      speechOnly: true,
    });
    assert.equal(speech.sid, "0:1");
    assert.equal(adapter.getStatus().audioSentBytes, 4800);
  } finally {
    await adapter.stop();
  }
  assert.equal(adapter.getStatus().phase, "stopped");
});
