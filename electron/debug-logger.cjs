"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

function defaultDebugLogPath({ homeDirectory = os.homedir() } = {}) {
  return path.join(homeDirectory, ".persona", "logs", "persona-dogfood.log");
}

function debugValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createDebugLogger({
  enabled = false,
  filePath = defaultDebugLogPath(),
  maxBytes = DEFAULT_MAX_LOG_BYTES,
  now = () => new Date(),
  stderr = (line) => console.error(line),
} = {}) {
  const resolvedPath = path.resolve(filePath);
  let initialized = false;
  let fileAvailable = enabled;

  function initialize() {
    if (!fileAvailable || initialized) return;
    initialized = true;
    try {
      fs.mkdirSync(path.dirname(resolvedPath), {
        mode: 0o700,
        recursive: true,
      });
      try {
        if (fs.statSync(resolvedPath).size >= maxBytes) {
          const suffix = now().toISOString().replace(/[^0-9A-Za-z.-]/g, "-");
          fs.renameSync(resolvedPath, `${resolvedPath}.${suffix}`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } catch (error) {
      fileAvailable = false;
      stderr(
        `[persona] ${now().toISOString()} debug log unavailable ${debugValue(
          error instanceof Error ? error.message : error,
        )}`,
      );
    }
  }

  function log(...values) {
    if (!enabled) return;
    const line = `[persona] ${now().toISOString()} ${values
      .map(debugValue)
      .join(" ")}`;
    stderr(line);
    initialize();
    if (!fileAvailable) return;
    try {
      fs.appendFileSync(resolvedPath, `${line}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (error) {
      fileAvailable = false;
      stderr(
        `[persona] ${now().toISOString()} debug log write failed ${debugValue(
          error instanceof Error ? error.message : error,
        )}`,
      );
    }
  }

  return { enabled, filePath: resolvedPath, log };
}

module.exports = {
  DEFAULT_MAX_LOG_BYTES,
  createDebugLogger,
  defaultDebugLogPath,
};
