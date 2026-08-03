"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createDebugLogger,
  defaultDebugLogPath,
} = require("./debug-logger.cjs");

test("debug logger persists one-line dogfood diagnostics with bounded values", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "persona-debug-log-"));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, "persona.log");
  const stderr = [];
  const logger = createDebugLogger({
    enabled: true,
    filePath,
    now: () => new Date("2026-08-02T23:00:00.000Z"),
    stderr: (line) => stderr.push(line),
  });

  logger.log("listener status", { capturing: true, source: "Codex" });

  const persisted = fs.readFileSync(filePath, "utf8");
  assert.equal(stderr.length, 1);
  assert.equal(persisted, `${stderr[0]}\n`);
  assert.match(persisted, /^\[persona\] 2026-08-02T23:00:00\.000Z /);
  assert.match(persisted, /\{"capturing":true,"source":"Codex"\}/);
});

test("disabled debug logger does not create a file", () => {
  const filePath = path.join(os.tmpdir(), `persona-disabled-${process.pid}.log`);
  const logger = createDebugLogger({ enabled: false, filePath });
  logger.log("ignored");
  assert.equal(fs.existsSync(filePath), false);
});

test("default dogfood log stays outside the repository", () => {
  assert.equal(
    defaultDebugLogPath({ homeDirectory: "/Users/persona" }),
    "/Users/persona/.persona/logs/persona-dogfood.log",
  );
});
