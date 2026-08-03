"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  S4B_DRIVER_ID,
  S4bAdapter,
  defaultS4bPackDirectory,
  parseManifest,
  resolveS4bPack,
} = require("./s4b-pack.cjs");

function createPack(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-s4b-pack-"));
  const manifest = {
    schema_version: 1,
    id: "test-persona",
    name: "Test Persona",
    width: 448,
    height: 960,
    cross_fade_ms: 90,
    mouth_gate: { close_delay_ms: 360, open_threshold: 0.02 },
    states: Object.fromEntries(
      ["idle", "listening", "thinking", "speaking"].map((activity) => [
        activity,
        { file: `${activity}.mp4` },
      ]),
    ),
    ...overrides,
  };
  for (const state of Object.values(manifest.states)) {
    if (typeof state?.file !== "string" || path.isAbsolute(state.file)) continue;
    const filePath = path.join(root, state.file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from("video"));
  }
  fs.writeFileSync(
    path.join(root, "s4b.json"),
    JSON.stringify(manifest),
  );
  return { manifest, root };
}

test("S4b pack normalizes four local state clips and mouth timing", () => {
  const { root } = createPack({
    background: "alpha",
    states: {
      idle: { file: "idle.mp4", playback_rate: 0.8 },
      listening: { file: "listening.mov", start_offset_ms: 500 },
      thinking: { file: "thinking.m4v" },
      speaking: { file: "speaking.webm", playback_rate: 1.25 },
    },
  });
  const pack = parseManifest(root);

  assert.equal(pack.publicPack.background, "alpha");
  assert.equal(pack.publicPack.crossFadeMs, 90);
  assert.deepEqual(pack.publicPack.mouthGate, {
    closeDelayMs: 360,
    openThreshold: 0.02,
  });
  assert.equal(pack.publicPack.clips.idle.playbackRate, 0.8);
  assert.equal(pack.publicPack.clips.listening.startOffsetMs, 500);
  assert.equal(pack.publicPack.clips.speaking.url, "persona-s4b://clip/speaking");
  assert.equal(pack.media.get("speaking").mimeType, "video/webm");
});

test("S4b pack enforces a mouth hold that spans natural sentence valleys", () => {
  const { root } = createPack({
    mouth_gate: { close_delay_ms: 140, open_threshold: 0.02 },
  });
  assert.equal(parseManifest(root).publicPack.mouthGate.closeDelayMs, 320);
});

test("S4b pack rejects missing states and paths outside its directory", () => {
  const missing = createPack();
  delete missing.manifest.states.thinking;
  fs.writeFileSync(
    path.join(missing.root, "s4b.json"),
    JSON.stringify(missing.manifest),
  );
  assert.throws(() => parseManifest(missing.root), /thinking.*missing/i);

  const traversal = createPack();
  traversal.manifest.states.idle.file = "../outside.mp4";
  fs.writeFileSync(
    path.join(traversal.root, "s4b.json"),
    JSON.stringify(traversal.manifest),
  );
  assert.throws(() => parseManifest(traversal.root), /inside the pack/i);
});

test("S4b pack rejects clip symlinks that escape its directory", () => {
  const { manifest, root } = createPack();
  const outside = path.join(os.tmpdir(), `persona-s4b-outside-${process.pid}.mp4`);
  fs.writeFileSync(outside, Buffer.from("outside"));
  fs.unlinkSync(path.join(root, "idle.mp4"));
  fs.symlinkSync(outside, path.join(root, "idle.mp4"));
  fs.writeFileSync(path.join(root, "s4b.json"), JSON.stringify(manifest));

  assert.throws(() => parseManifest(root), /symlinks.*inside/i);
});

test("S4b adapter publishes one bounded pack and resolves only clip URLs", () => {
  const { root } = createPack();
  const resolved = resolveS4bPack({ candidates: [root] });
  const events = [];
  const statuses = [];
  let clock = 10;
  const adapter = new S4bAdapter({
    now: () => ++clock,
    onPack: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    pack: resolved,
  });

  assert.equal(adapter.start(), true);
  assert.equal(adapter.start(), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "avatar-state-pack");
  assert.equal(adapter.getStatus().driverId, S4B_DRIVER_ID);
  assert.equal(adapter.getStatus().phase, "ready");
  assert.equal(adapter.getStatus().clipCount, 4);
  assert.equal(statuses[0].phase, "starting");
  assert.equal(statuses.at(-1).phase, "ready");
  assert.match(
    adapter.resolveMediaRequest("persona-s4b://clip/idle").filePath,
    /idle\.mp4$/,
  );
  assert.equal(adapter.resolveMediaRequest("persona-s4b://other/idle"), null);
  assert.equal(adapter.resolveMediaRequest("persona-s4b://clip/unknown"), null);
  assert.equal(adapter.resolveMediaRequest("persona-s4b://clip/%zz"), null);

  adapter.stop();
  assert.equal(adapter.getStatus().phase, "stopped");
});

test("S4b adapter fails closed when no validated manifest exists", () => {
  const adapter = new S4bAdapter({
    pack: resolveS4bPack({ candidates: [] }),
  });
  assert.equal(adapter.start(), false);
  assert.equal(adapter.getStatus().phase, "failed");
  assert.match(adapter.getStatus().error, /s4b\.json/i);
  assert.equal(adapter.resolveMediaRequest("persona-s4b://clip/idle"), null);
});

test("S4b development pack stays outside the repository by default", () => {
  assert.equal(
    defaultS4bPackDirectory({ homeDirectory: "/Users/test" }),
    path.join("/Users/test", ".persona", "avatar-packs", "s4b-default"),
  );
});
