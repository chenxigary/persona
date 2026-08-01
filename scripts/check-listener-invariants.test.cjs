"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseLine,
  parseLog,
  report,
  summarise,
} = require("./check-listener-invariants.cjs");

const START = Date.parse("2026-08-01T20:00:00.000Z");

function at(offsetSeconds) {
  return new Date(START + offsetSeconds * 1000).toISOString();
}

function status(offsetSeconds, capturing) {
  return `[persona] ${at(offsetSeconds)} listener status ${JSON.stringify({
    available: true,
    capturing,
    monitoring: true,
    source: capturing ? "macOS process audio" : null,
  })}`;
}

function activity(offsetSeconds, name) {
  return `[persona] ${at(offsetSeconds)} listener activity ${name}`;
}

test("parses the timestamped single-line debug format", () => {
  assert.deepEqual(parseLine(activity(0, "speaking")), {
    at: START,
    kind: "activity",
    activity: "speaking",
  });
  assert.equal(parseLine(status(0, true)).status.capturing, true);
  assert.deepEqual(parseLine(`[persona] ${at(0)} listener session true`), {
    at: START,
    kind: "session",
    active: true,
  });
});

test("ignores unrelated and malformed lines instead of throwing", () => {
  assert.equal(parseLine("some npm output"), null);
  assert.equal(parseLine("[persona] not-a-date listener status {}"), null);
  assert.equal(parseLine("[persona] 2026-08-01T20:00:00.000Z listener status {oops"), null);
});

test("a healthy run passes every invariant", () => {
  // Two conversations: tap appears with speech, releases a few seconds after.
  const log = [
    status(0, false),
    status(30, true),
    activity(30, "listening"),
    activity(31, "speaking"),
    activity(38, "listening"),
    status(41, false),
    status(120, true),
    activity(121, "speaking"),
    activity(129, "listening"),
    status(132, false),
  ].join("\n");

  const { failures, text } = report(summarise(parseLog(log)));
  assert.deepEqual(failures, []);
  assert.match(text, /每次 tap 期间都有说话活动/);
});

test("flags a tap held while the target is silent", () => {
  // This is the condition that stops the voice session connecting.
  const log = [
    status(0, false),
    status(10, true),
    status(90, false),
  ].join("\n");

  const { failures, text } = report(summarise(parseLog(log)));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /没有说话/);
  assert.match(text, /阻断语音会话建立的条件/);
});

test("flags the old rebuild churn", () => {
  // The pre-fix behaviour: a rebuild on most 1.5s polls.
  const lines = [];
  for (let index = 0; index < 12; index += 1) {
    const base = index * 2;
    lines.push(status(base, true));
    lines.push(activity(base + 0.5, "speaking"));
    lines.push(status(base + 1, false));
  }
  const { failures } = report(summarise(parseLog(lines.join("\n"))));
  assert.ok(
    failures.some((failure) => /重建过于频繁/.test(failure)),
    `expected churn failure, got ${JSON.stringify(failures)}`,
  );
});

test("flags a tap that lingers long after speech stopped", () => {
  const log = [
    status(0, true),
    activity(1, "speaking"),
    activity(5, "listening"),
    status(60, false),
  ].join("\n");

  const { failures } = report(summarise(parseLog(log)));
  assert.ok(failures.some((failure) => /释放过慢/.test(failure)));
});

test("reports an empty run as undecidable rather than passing it", () => {
  const { failures, text } = report(summarise(parseLog(status(0, false))));
  assert.deepEqual(failures, ["没有可判定的数据"]);
  assert.match(text, /没有任何 tap 建立记录/);
});

test("does not treat a tap still open at Ctrl-C as a failure", () => {
  const log = [
    status(0, true),
    activity(1, "speaking"),
    activity(9, "listening"),
  ].join("\n");

  const { failures, text } = report(summarise(parseLog(log)));
  assert.deepEqual(failures, []);
  assert.match(text, /仍然打开/);
});
