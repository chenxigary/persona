"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough, Writable } = require("node:stream");
const test = require("node:test");
const {
  LiteAvatarAdapter,
  Pcm16Resampler,
  createLiteAvatarFrameResponse,
  createProtocolParser,
  resolveLiteAvatarRuntime,
  runtimePaths,
  validJpeg,
} = require("./liteavatar-adapter.cjs");

const JPEG = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function stateEvent(activity, phase = "active") {
  return {
    type: "state",
    state: {
      activity,
      microphoneMuted: false,
      outputMuted: false,
      phase,
    },
  };
}

class FakeChild extends EventEmitter {
  constructor({ exitOnStop = true, pid = 4321 } = {}) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.commands = [];
    this.killedWith = null;
    this.exitOnStop = exitOnStop;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString("utf8").trim().split("\n")) {
          if (!line) continue;
          const command = JSON.parse(line);
          this.commands.push(command);
          if (command.cmd === "stop" && this.exitOnStop) {
            setImmediate(() => this.emit("exit", 0, null));
          }
        }
        callback();
      },
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal) {
    this.killedWith = signal;
    setImmediate(() => this.emit("exit", null, signal));
    return true;
  }
}

function availableRuntime(root = "/runtime") {
  return { ...runtimePaths(root), available: true };
}

function createFakeAdapter(options = {}) {
  const children = [];
  const adapter = new LiteAvatarAdapter({
    endGraceMs: 2,
    existsSync: () => true,
    initTimeoutMs: 1_000,
    maxRestarts: 0,
    runtime: availableRuntime(),
    silenceTimeoutMs: 60_000,
    spawnProcess: () => {
      const child = new FakeChild({ pid: 4321 + children.length });
      children.push(child);
      return child;
    },
    workerPath: "/persona/native/liteavatar/worker.py",
    ...options,
  });
  return { adapter, children };
}

test("LiteAvatar runtime resolution requires Python, OpenAvatarChat, and weights", () => {
  const first = runtimePaths("/first");
  const second = runtimePaths("/second");
  const present = new Set([
    second.pythonPath,
    second.oacDirectory,
    second.weightPath,
  ]);
  const resolved = resolveLiteAvatarRuntime({
    candidates: [first.runtimeRoot, second.runtimeRoot],
    existsSync: (candidate) => present.has(candidate),
  });

  assert.equal(resolved.available, true);
  assert.equal(resolved.runtimeRoot, second.runtimeRoot);
  assert.equal(
    resolveLiteAvatarRuntime({ candidates: [first.runtimeRoot], existsSync: () => false })
      .available,
    false,
  );
});

test("the macOS package carries Persona's worker but not the external model runtime", () => {
  const packageConfig = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "package.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    packageConfig.build.mac.extraResources.find(
      (resource) => resource.from === "native/liteavatar/worker.py",
    ),
    {
      from: "native/liteavatar/worker.py",
      to: "native/liteavatar/worker.py",
    },
  );
  assert.equal(
    packageConfig.build.mac.extraResources.some((resource) =>
      resource.from.includes("OpenAvatarChat"),
    ),
    false,
  );
});

test("LiteAvatar protocol parser bounds and isolates invalid worker output", () => {
  const messages = [];
  const invalid = [];
  const parse = createProtocolParser({
    maxLineChars: 32,
    onInvalid: (detail) => invalid.push(detail.reason),
    onMessage: (message) => messages.push(message),
  });

  parse(Buffer.from('{"ok":true}\nnot-json\n'));
  parse(Buffer.from(`${"x".repeat(40)}\n`));

  assert.deepEqual(messages, [{ ok: true }]);
  assert.deepEqual(invalid, ["invalid-json", "line-too-large"]);
});

test("PCM resampler preserves duration across differently sized chunks", () => {
  const resampler = new Pcm16Resampler(24_000);
  const first = resampler.process(Buffer.alloc(220 * 2), 44_100);
  const second = resampler.process(Buffer.alloc(221 * 2), 44_100);
  assert.equal(first.length + second.length, 240 * 2);

  const passthrough = Buffer.from([1, 0, 2, 0]);
  assert.deepEqual(resampler.process(passthrough, 24_000), passthrough);
});

test("adapter initializes, chunks speech PCM, serves frames, and rejects stale frames", async () => {
  const frames = [];
  const { adapter, children } = createFakeAdapter({
    onFrame: (frame) => frames.push(frame),
  });
  adapter.start();
  await nextTurn();
  const child = children[0];
  assert.equal(child.commands[0].cmd, "init");
  assert.equal(child.commands[0].emit_audio, false);
  assert.equal(child.commands[0].use_gpu, false);

  child.send({ load_s: 4.2, ok: true });
  const ready = await adapter.waitUntilReady();
  assert.equal(ready.phase, "ready");
  assert.equal(ready.loadSeconds, 4.2);

  await adapter.handlePcm({ data: Buffer.alloc(9600), sampleRate: 48_000 });
  assert.equal(adapter.getStatus().audioDroppedOutsideSpeech, 1);

  adapter.handleEvent(stateEvent("speaking"));
  await adapter.handlePcm({ data: Buffer.alloc(9600, 3), sampleRate: 48_000 });
  await nextTurn();
  const audio = child.commands.find(
    (command) => command.cmd === "audio" && command.end === false,
  );
  assert.equal(audio.sid, "0:1");
  assert.equal(Buffer.from(audio.chunk, "base64").length, 4800);

  child.send({ jpg: JPEG.toString("base64"), sid: "0:1", t: "v" });
  const speechFrame = await adapter.waitForFrame({ speechOnly: true });
  assert.equal(speechFrame.sid, "0:1");
  assert.equal(validJpeg(speechFrame.jpeg), true);
  assert.equal(frames.length, 1);

  const response = createLiteAvatarFrameResponse(
    adapter,
    `persona-avatar://frame/${speechFrame.sequence}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), JPEG);
  assert.equal(
    createLiteAvatarFrameResponse(adapter, "persona-avatar://other/1").status,
    404,
  );

  adapter.handleEvent(stateEvent("idle", "inactive"));
  await nextTurn();
  child.send({ jpg: JPEG.toString("base64"), sid: "0:1", t: "v" });
  await nextTurn();
  assert.equal(adapter.getStatus().staleFrames, 1);
  assert.equal(frames.length, 1);
  child.send({ jpg: JPEG.toString("base64"), sid: "../../bad", t: "v" });
  await nextTurn();
  assert.equal(adapter.getStatus().invalidMessages, 1);

  await adapter.stop();
  assert.equal(adapter.getStatus().phase, "stopped");
});

test("adapter flushes the final partial chunk at end of speech", async () => {
  const { adapter, children } = createFakeAdapter();
  adapter.start();
  children[0].send({ ok: true });
  await adapter.waitUntilReady();
  adapter.handleEvent(stateEvent("speaking"));
  await adapter.handlePcm({ data: Buffer.alloc(3200), sampleRate: 16_000 });
  adapter.handleEvent(stateEvent("listening"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const audio = children[0].commands.filter((command) => command.cmd === "audio");
  assert.equal(audio.length, 2);
  assert.equal(audio[0].end, false);
  assert.equal(Buffer.from(audio[0].chunk, "base64").length, 4800);
  assert.equal(audio[1].end, true);
  assert.equal(audio[1].chunk, "");
  await adapter.stop();
});

test("adapter fails cleanly when the external runtime is absent", async () => {
  const adapter = new LiteAvatarAdapter({
    existsSync: () => false,
    runtime: { available: false },
  });
  adapter.start();
  assert.equal(adapter.getStatus().phase, "failed");
  assert.match(adapter.getStatus().error, /runtime is incomplete/i);
  await assert.rejects(adapter.waitUntilReady(), /runtime is incomplete/i);
});

test("a pending frame wait rejects immediately when the worker fails", async () => {
  const { adapter, children } = createFakeAdapter();
  adapter.start();
  children[0].send({ ok: true });
  await adapter.waitUntilReady();
  const waiting = adapter.waitForFrame({ afterSequence: 99, timeoutMs: 1_000 });
  children[0].send({ error: "model failed" });
  await assert.rejects(waiting, /model failed/);
  await adapter.stop();
});

test("adapter restarts a crashed worker once, then reports failure", async () => {
  const { adapter, children } = createFakeAdapter({
    maxRestarts: 1,
    restartDelayMs: 1,
  });
  adapter.start();
  children[0].emit("exit", 17, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children.length, 2);
  children[1].emit("exit", 18, null);
  await nextTurn();

  const status = adapter.getStatus();
  assert.equal(status.phase, "failed");
  assert.equal(status.restartCount, 1);
  assert.match(status.error, /code 18/);
});
