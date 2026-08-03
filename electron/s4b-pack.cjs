"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const S4B_DRIVER_ID = "s4b";
const S4B_MANIFEST_FILENAME = "s4b.json";
const S4B_ACTIVITIES = Object.freeze([
  "idle",
  "listening",
  "thinking",
  "speaking",
]);
const VIDEO_MIME_TYPES = Object.freeze({
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
});

function boundedNumber(value, fallback, minimum, maximum) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function defaultS4bPackDirectory({ homeDirectory = os.homedir() } = {}) {
  return path.join(
    homeDirectory,
    ".persona",
    "avatar-packs",
    "s4b-default",
  );
}

function defaultS4bPackCandidates({
  explicitRoot = null,
  homeDirectory = os.homedir(),
  resourcesPath = process.resourcesPath,
} = {}) {
  return [
    explicitRoot,
    process.env.PERSONA_S4B_PACK,
    resourcesPath ? path.join(resourcesPath, "avatar-packs", "s4b-default") : null,
    defaultS4bPackDirectory({ homeDirectory }),
  ].filter(
    (candidate, index, candidates) =>
      candidate && candidates.indexOf(candidate) === index,
  );
}

function publicError(error) {
  if (!error) return null;
  return String(error)
    .replaceAll(os.homedir(), "~")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function insideDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function resolveClipFile(root, requestedFile, { realpathSync = fs.realpathSync, statSync = fs.statSync } = {}) {
  if (
    typeof requestedFile !== "string" ||
    requestedFile.length === 0 ||
    requestedFile.length > 240 ||
    requestedFile.includes("\0") ||
    path.isAbsolute(requestedFile)
  ) {
    throw new Error("S4b clip paths must be short relative paths.");
  }
  const candidate = path.resolve(root, requestedFile);
  if (!insideDirectory(root, candidate)) {
    throw new Error("S4b clip paths must stay inside the pack directory.");
  }
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  if (!insideDirectory(realRoot, realCandidate)) {
    throw new Error("S4b clip symlinks must stay inside the pack directory.");
  }
  const stats = statSync(realCandidate);
  if (!stats.isFile()) throw new Error("S4b clips must be regular files.");
  const extension = path.extname(realCandidate).toLowerCase();
  const mimeType = VIDEO_MIME_TYPES[extension];
  if (!mimeType) {
    throw new Error(`Unsupported S4b clip type "${extension || "none"}".`);
  }
  return { filePath: realCandidate, mimeType };
}

function parseManifest(root, {
  readFileSync = fs.readFileSync,
  realpathSync = fs.realpathSync,
  statSync = fs.statSync,
} = {}) {
  const manifestPath = path.join(root, S4B_MANIFEST_FILENAME);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${S4B_MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (manifest?.schema_version !== 1) {
    throw new Error("S4b manifest schema_version must be 1.");
  }
  if (
    typeof manifest.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(manifest.id)
  ) {
    throw new Error("S4b manifest id is invalid.");
  }
  if (
    typeof manifest.name !== "string" ||
    manifest.name.trim().length === 0 ||
    manifest.name.length > 80
  ) {
    throw new Error("S4b manifest name is invalid.");
  }
  if (
    !Number.isInteger(manifest.width) ||
    manifest.width < 64 ||
    manifest.width > 3840 ||
    !Number.isInteger(manifest.height) ||
    manifest.height < 64 ||
    manifest.height > 3840
  ) {
    throw new Error("S4b manifest dimensions must be integers from 64 to 3840.");
  }
  if (manifest.states == null || typeof manifest.states !== "object") {
    throw new Error("S4b manifest states are missing.");
  }

  const clips = {};
  const media = new Map();
  for (const activity of S4B_ACTIVITIES) {
    const state = manifest.states[activity];
    if (state == null || typeof state !== "object") {
      throw new Error(`S4b manifest state "${activity}" is missing.`);
    }
    const resolved = resolveClipFile(root, state.file, {
      realpathSync,
      statSync,
    });
    const clip = {
      activity,
      playbackRate: boundedNumber(state.playback_rate, 1, 0.25, 4),
      startOffsetMs: Math.round(
        boundedNumber(state.start_offset_ms, 0, 0, 600_000),
      ),
      url: `persona-s4b://clip/${activity}`,
    };
    clips[activity] = clip;
    media.set(activity, resolved);
  }

  return {
    media,
    publicPack: {
      background: manifest.background === "alpha" ? "alpha" : "opaque",
      clips,
      crossFadeMs: Math.round(
        boundedNumber(manifest.cross_fade_ms, 120, 0, 500),
      ),
      height: manifest.height,
      id: manifest.id,
      mouthGate: {
        closeDelayMs: Math.round(
          boundedNumber(manifest.mouth_gate?.close_delay_ms, 320, 320, 500),
        ),
        openThreshold: boundedNumber(
          manifest.mouth_gate?.open_threshold,
          0.018,
          0,
          1,
        ),
      },
      name: manifest.name.trim(),
      width: manifest.width,
    },
    root: realpathSync(root),
  };
}

function resolveS4bPack({ candidates = defaultS4bPackCandidates(), existsSync = fs.existsSync } = {}) {
  const errors = [];
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (!existsSync(path.join(root, S4B_MANIFEST_FILENAME))) continue;
    try {
      return { ...parseManifest(root), available: true };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    available: false,
    error:
      errors[0] ||
      `No ${S4B_MANIFEST_FILENAME} was found. Run npm run s4b:prepare or set PERSONA_S4B_PACK.`,
  };
}

class S4bAdapter {
  constructor({
    now = () => Date.now(),
    onPack = () => {},
    onStatus = () => {},
    pack = resolveS4bPack(),
  } = {}) {
    this.now = now;
    this.onPack = onPack;
    this.onStatus = onStatus;
    this.pack = pack;
    this.phase = "off";
    this.error = null;
    this.loadMs = null;
  }

  updateStatus(phase, error = null) {
    this.phase = phase;
    this.error = publicError(error);
    const status = this.getStatus();
    this.onStatus(status);
    return status;
  }

  start() {
    if (this.phase === "starting" || this.phase === "ready") return false;
    const startedAt = this.now();
    this.updateStatus("starting");
    if (!this.pack.available) {
      this.loadMs = this.now() - startedAt;
      this.updateStatus("failed", this.pack.error || "S4b pack is unavailable.");
      return false;
    }
    this.loadMs = this.now() - startedAt;
    this.onPack({
      pack: this.pack.publicPack,
      type: "avatar-state-pack",
    });
    this.updateStatus("ready");
    return true;
  }

  getStatus() {
    return {
      clipCount: this.pack.available ? this.pack.media.size : 0,
      driverId: S4B_DRIVER_ID,
      error: this.error,
      loadMs: this.loadMs,
      packId: this.pack.available ? this.pack.publicPack.id : null,
      packName: this.pack.available ? this.pack.publicPack.name : null,
      phase: this.phase,
      runtimeAvailable: this.pack.available,
      surface: "s4b",
    };
  }

  resolveMediaRequest(requestUrl) {
    if (!this.pack.available) return null;
    let url;
    try {
      url = new URL(requestUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "persona-s4b:" || url.hostname !== "clip") return null;
    let activity;
    try {
      activity = decodeURIComponent(url.pathname.replace(/^\//, ""));
    } catch {
      return null;
    }
    if (!S4B_ACTIVITIES.includes(activity)) return null;
    return this.pack.media.get(activity) ?? null;
  }

  stop() {
    if (this.phase === "stopped" || this.phase === "off") return;
    this.updateStatus("stopped");
  }
}

module.exports = {
  S4B_ACTIVITIES,
  S4B_DRIVER_ID,
  S4B_MANIFEST_FILENAME,
  S4bAdapter,
  VIDEO_MIME_TYPES,
  defaultS4bPackCandidates,
  defaultS4bPackDirectory,
  parseManifest,
  resolveClipFile,
  resolveS4bPack,
};
