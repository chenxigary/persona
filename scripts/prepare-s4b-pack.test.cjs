"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  NEUTRAL_FRAME_COUNT,
  PACK_GENERATOR_VERSION,
  targetSpeechFrameCount,
} = require("./prepare-s4b-pack.cjs");

test("S4b speaking preparation preserves the source speech duration", () => {
  const sampleRate = 16_000;
  const durationSeconds = 5.546687;
  const samples = Math.round(sampleRate * durationSeconds);
  const speechFrames = targetSpeechFrameCount({
    data: Buffer.alloc(samples * 2),
    sampleRate,
  });

  assert.equal(speechFrames, 166);
  const encodedSeconds =
    (speechFrames + NEUTRAL_FRAME_COUNT * 2) / 30;
  assert.ok(
    Math.abs(encodedSeconds - durationSeconds) < 0.35,
    `encoded loop changed ${durationSeconds}s of speech into ${encodedSeconds}s`,
  );
  assert.equal(PACK_GENERATOR_VERSION, 2);
});
