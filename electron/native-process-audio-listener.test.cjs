"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  NativeProcessAudioListener,
  createNdjsonParser,
  resolveNativeHelperPath,
} = require("./native-process-audio-listener.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("exit", 0, "SIGTERM");
  return child;
}

test("NDJSON parser buffers partial messages and rejects malformed lines", () => {
  const messages = [];
  const invalid = [];
  const parse = createNdjsonParser(
    (message) => messages.push(message),
    (line) => invalid.push(line),
  );
  parse('{"type":"rea');
  parse('dy"}\nnot-json\n{"type":"level","level":0.2}\n');
  assert.deepEqual(messages, [
    { type: "ready" },
    { type: "level", level: 0.2 },
  ]);
  assert.deepEqual(invalid, ["not-json"]);
});

test("resolves development and packaged helper locations on both native platforms", () => {
  assert.equal(
    resolveNativeHelperPath({
      platform: "win32",
      projectRoot: "C:\\project",
      isPackaged: true,
      resourcesPath: "C:\\resources",
    }),
    "C:\\resources\\native\\win32\\persona-audio-listener.exe",
  );
  assert.equal(
    resolveNativeHelperPath({
      platform: "win32",
      projectRoot: "C:\\project",
      isPackaged: false,
    }),
    "C:\\project\\native\\bin\\win32\\persona-audio-listener.exe",
  );
  assert.equal(
    resolveNativeHelperPath({
      platform: "darwin",
      projectRoot: "/project",
      isPackaged: false,
    }),
    "/project/native/bin/darwin/persona-audio-listener",
  );
});

test("native listener activates on audio, smooths speech, and never hides the window", async () => {
  const activities = [];
  const sessions = [];
  const statuses = [];
  const child = fakeChild();
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: async () => ({ pids: [10, 11], rootPids: [10] }),
    spawnProcess: () => child,
    onActivity: (activity) => activities.push(activity),
    onSession: (active) => sessions.push(active),
    onStatus: (status) => statuses.push(status),
    sessionIdleMs: 35,
    speechReleaseMs: 15,
  });

  await listener.start();
  child.stdout.emit("data", '{"type":"ready","source":"Codex"}\n');
  child.stdout.emit("data", '{"type":"level","level":0.3}\n');
  child.stdout.emit("data", '{"type":"level","level":0}\n');
  await new Promise((resolve) => setTimeout(resolve, 22));

  assert.deepEqual(sessions, [true]);
  assert.deepEqual(activities, ["listening", "speaking", "listening"]);
  assert.equal(statuses.at(-1).capturing, true);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(sessions, [true, false]);
  listener.stop();
});

test("native listener cannot attach after it is stopped during discovery", async () => {
  let finishDiscovery;
  let spawnCount = 0;
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: () =>
      new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    spawnProcess: () => {
      spawnCount += 1;
      return fakeChild();
    },
  });

  const starting = listener.start();
  listener.stop();
  finishDiscovery({ pids: [10], rootPids: [10] });
  await starting;

  assert.equal(spawnCount, 0);
});

test("native listener coalesces helper-process churn into one reattach per cooldown", async () => {
  let pids = [10, 11, 12];
  let clock = 1_000;
  let spawnCount = 0;
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    pollIntervalMs: 60_000,
    reattachCooldownMs: 5_000,
    now: () => clock,
    processDiscovery: async () => ({ pids: [...pids], rootPids: [10] }),
    spawnProcess: () => {
      spawnCount += 1;
      return fakeChild();
    },
  });

  await listener.start();
  assert.equal(spawnCount, 1);

  // Short-lived helper processes appear and disappear while every process the
  // helper is already tapping stays alive. Chromium and Electron based voice
  // clients do this continuously, and rebuilding the Core Audio tap for each
  // change tears down the aggregate device without changing what is metered.
  for (const churn of [[13], [13, 14], [15], [16]]) {
    pids = [10, 11, 12, ...churn];
    clock += 1_500;
    await listener.poll();
  }

  assert.equal(spawnCount, 2, "expected one coalesced reattach, not one per poll");
  listener.stop();
});

test("native listener never rebuilds the tap during an active voice session", async () => {
  let pids = [10, 11];
  let clock = 1_000;
  let spawnCount = 0;
  let child = null;
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    pollIntervalMs: 60_000,
    reattachCooldownMs: 5_000,
    sessionIdleMs: 60_000,
    now: () => clock,
    processDiscovery: async () => ({ pids: [...pids], rootPids: [10] }),
    spawnProcess: () => {
      spawnCount += 1;
      child = fakeChild();
      return child;
    },
  });

  await listener.start();
  child.stdout.emit("data", '{"type":"ready","source":"Codex"}\n');
  child.stdout.emit("data", '{"type":"level","level":0.4}\n');

  for (let index = 0; index < 6; index += 1) {
    pids = [10, 11, 100 + index];
    clock += 3_000;
    await listener.poll();
  }

  assert.equal(spawnCount, 1, "a live session must not be interrupted by process churn");
  listener.stop();
});

test("native listener reattaches immediately when every tapped process disappears", async () => {
  let pids = [10, 11];
  let clock = 1_000;
  const spawnedArgs = [];
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    pollIntervalMs: 60_000,
    reattachCooldownMs: 5_000,
    now: () => clock,
    processDiscovery: async () => ({ pids: [...pids], rootPids: [pids[0]] }),
    spawnProcess: (_helperPath, args) => {
      spawnedArgs.push(args);
      return fakeChild();
    },
  });

  await listener.start();
  assert.deepEqual(spawnedArgs, [["--pid", "10", "--pid", "11"]]);

  // The voice application restarted: same identity, brand new pids, and still
  // well inside the cooldown window.
  pids = [20, 21];
  clock += 500;
  await listener.poll();

  assert.equal(spawnedArgs.length, 2);
  assert.deepEqual(spawnedArgs.at(-1), ["--pid", "20", "--pid", "21"]);
  listener.stop();
});

test("native listener resolves the configured application before capture", async () => {
  let discoveryOptions = null;
  const voiceSource = {
    mode: "application",
    process_pattern: null,
    source_id: "process:darwin:Vm9pY2U",
    source_name: "Voice",
  };
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    voiceSource,
    processDiscovery: async (options) => {
      discoveryOptions = options;
      return { pids: [], rootPids: [] };
    },
  });

  await listener.start();
  listener.stop();

  assert.deepEqual(discoveryOptions.voiceSource, voiceSource);
});
