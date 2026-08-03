#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  LITEAVATAR_DRIVER_ID,
  createAvatarDriverHost,
} = require("../electron/avatar-driver.cjs");
const {
  LiteAvatarAdapter,
  resolveLiteAvatarRuntime,
} = require("../electron/liteavatar-adapter.cjs");
const {
  defaultS4bPackDirectory,
  resolveS4bPack,
} = require("../electron/s4b-pack.cjs");

const AVATAR_NAME = "20250408/sample_data";
const FPS = 30;
const NEUTRAL_FRAME_COUNT = 5;
const PACK_GENERATOR = "Persona S4b local pack builder";
const PACK_GENERATOR_VERSION = 2;
const HEIGHT = 1920;
const WIDTH = 890;
const projectRoot = path.join(__dirname, "..");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    force: false,
    output: process.env.PERSONA_S4B_PACK || defaultS4bPackDirectory(),
    runtime: process.env.PERSONA_LITEAVATAR_RUNTIME || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--force") options.force = true;
    else if (argv[index] === "--output" && argv[index + 1]) {
      options.output = path.resolve(argv[++index]);
    } else if (argv[index] === "--runtime" && argv[index + 1]) {
      options.runtime = path.resolve(argv[++index]);
    } else {
      throw new Error(`Unknown S4b pack option "${argv[index]}".`);
    }
  }
  return options;
}

function run(command, args, { cwd = projectRoot, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (quiet) {
      const collect = (chunk) => {
        output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else {
        reject(
          new Error(
            `${path.basename(command)} exited with ${code ?? signal}.${
              output ? ` ${output.trim()}` : ""
            }`,
          ),
        );
      }
    });
  });
}

function readWave(filePath) {
  const wave = fs.readFileSync(filePath);
  if (
    wave.subarray(0, 4).toString("ascii") !== "RIFF" ||
    wave.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error("S4b speech source is not a RIFF/WAVE file.");
  }
  let format = null;
  let data = null;
  for (let offset = 12; offset + 8 <= wave.length; ) {
    const id = wave.subarray(offset, offset + 4).toString("ascii");
    const size = wave.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(wave.length, start + size);
    if (id === "fmt " && size >= 16) {
      format = {
        bitsPerSample: wave.readUInt16LE(start + 14),
        channels: wave.readUInt16LE(start + 2),
        encoding: wave.readUInt16LE(start),
        sampleRate: wave.readUInt32LE(start + 4),
      };
    } else if (id === "data") {
      data = Buffer.from(wave.subarray(start, end));
    }
    offset = start + size + (size % 2);
  }
  if (
    !format ||
    !data?.length ||
    format.encoding !== 1 ||
    format.channels !== 1 ||
    format.bitsPerSample !== 16
  ) {
    throw new Error("S4b speech source must be mono PCM s16le.");
  }
  return { data, sampleRate: format.sampleRate };
}

function speechWavePath(runtime) {
  return path.join(
    runtime.oacDirectory,
    "src",
    "handlers",
    "avatar",
    "liteavatar",
    "algo",
    "liteavatar",
    "weights",
    "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "example",
    "asr_example.wav",
  );
}

function sampleFrames(frames, count) {
  if (frames.length === 0) throw new Error("LiteAvatar produced no speech frames.");
  return Array.from({ length: count }, (_, index) =>
    frames[
      Math.min(
        frames.length - 1,
        Math.floor((index * frames.length) / count),
      )
    ],
  );
}

function targetSpeechFrameCount(wave, fps = FPS) {
  const audioFrames = wave.data.length / 2;
  const durationSeconds = audioFrames / wave.sampleRate;
  return Math.max(1, Math.round(durationSeconds * fps));
}

function personaGeneratorVersion(root) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "s4b.json"), "utf8"),
    );
    if (manifest?.source?.generator !== PACK_GENERATOR) return null;
    const version = Number(manifest.source.generator_version ?? 0);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
  } catch {
    return null;
  }
}

async function renderSpeakingFrames(runtime) {
  const wave = readWave(speechWavePath(runtime));
  const speechFrameCount = targetSpeechFrameCount(wave);
  let idleBefore = null;
  const speech = [];
  const adapter = new LiteAvatarAdapter({
    device: process.env.PERSONA_LITEAVATAR_DEVICE || "mps",
    endGraceMs: 80,
    fps: FPS,
    height: HEIGHT,
    maxRestarts: 0,
    onDebug: (...details) => {
      if (process.env.PERSONA_DEBUG === "1") {
        console.error("[s4b-prepare]", ...details);
      }
    },
    runtime,
    width: WIDTH,
  });
  adapter.on("frame", ({ sid }) => {
    const frame = adapter.getFrame();
    if (!frame?.jpeg) return;
    const jpeg = Buffer.from(frame.jpeg);
    if (sid) speech.push(jpeg);
    else if (speech.length === 0) idleBefore = jpeg;
  });
  const driver = createAvatarDriverHost({
    adapter,
    driverId: LITEAVATAR_DRIVER_ID,
  });

  try {
    if (!driver.start()) throw new Error("LiteAvatar could not start for S4b preparation.");
    await adapter.waitUntilReady(240_000);
    await adapter.waitForFrame({ timeoutMs: 30_000 });
    driver.handleEvent({
      type: "state",
      state: {
        activity: "speaking",
        microphoneMuted: false,
        outputMuted: false,
        phase: "active",
      },
    });
    const chunkFrames = Math.round(wave.sampleRate * 0.02);
    const chunkBytes = chunkFrames * 2;
    let sequence = 0;
    for (let offset = 0; offset < wave.data.length; offset += chunkBytes) {
      const data = Buffer.from(wave.data.subarray(offset, offset + chunkBytes));
      driver.handlePcm({
        channels: 1,
        data,
        encoding: "s16le",
        frames: data.length / 2,
        sampleRate: wave.sampleRate,
        sequence,
      });
      sequence += 1;
      await delay(20);
    }
    await driver.flushPcm();
    driver.handleEvent({
      type: "state",
      state: {
        activity: "listening",
        microphoneMuted: false,
        outputMuted: false,
        phase: "active",
      },
    });
    await waitUntil(
      () => speech.length >= speechFrameCount,
      90_000,
      `LiteAvatar did not finish the S4b loop (${speech.length}/${speechFrameCount} speech frames).`,
    );
  } finally {
    await driver.stop();
  }

  const opening = idleBefore || speech[0];
  return [
    ...Array.from({ length: NEUTRAL_FRAME_COUNT }, () => opening),
    ...sampleFrames(speech, speechFrameCount),
    ...Array.from({ length: NEUTRAL_FRAME_COUNT }, () => opening),
  ];
}

async function transcodeWithAvconvert(source, output) {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/avconvert")) {
    throw new Error("The automatic LiteAvatar-to-S4b preparation path currently requires macOS avconvert.");
  }
  await run(
    "/usr/bin/avconvert",
    [
      "--source",
      source,
      "--preset",
      "PresetHighestQuality",
      "--output",
      output,
      "--replace",
      "--disableMetadataFilter",
    ],
    { quiet: true },
  );
}

async function buildPack({ buildDirectory, runtime, sourceDirectory }) {
  const sourceVideo = path.join(sourceDirectory, "bg_video.mp4");
  if (!fs.existsSync(sourceVideo)) {
    throw new Error(`LiteAvatar background video is missing: ${sourceVideo}`);
  }
  process.stdout.write("Preparing the idle/listening/thinking loops…\n");
  await transcodeWithAvconvert(sourceVideo, path.join(buildDirectory, "idle.mov"));
  fs.copyFileSync(
    path.join(buildDirectory, "idle.mov"),
    path.join(buildDirectory, "listening.mov"),
  );
  fs.copyFileSync(
    path.join(buildDirectory, "idle.mov"),
    path.join(buildDirectory, "thinking.mov"),
  );

  process.stdout.write("Rendering one generic closed-loop speaking clip…\n");
  const speakingFrames = await renderSpeakingFrames(runtime);
  const framesDirectory = path.join(buildDirectory, "speaking-frames");
  fs.mkdirSync(framesDirectory);
  speakingFrames.forEach((jpeg, index) => {
    fs.writeFileSync(
      path.join(framesDirectory, `frame_${String(index).padStart(5, "0")}.jpg`),
      jpeg,
    );
  });
  const intermediate = path.join(buildDirectory, "speaking-intermediate.mp4");
  await run(runtime.pythonPath, [
    path.join(projectRoot, "scripts", "encode-s4b-video.py"),
    "--frames",
    framesDirectory,
    "--output",
    intermediate,
    "--fps",
    String(FPS),
  ]);
  await transcodeWithAvconvert(
    intermediate,
    path.join(buildDirectory, "speaking.mov"),
  );
  fs.rmSync(framesDirectory, { force: true, recursive: true });
  fs.rmSync(intermediate, { force: true });

  const manifest = {
    schema_version: 1,
    id: "liteavatar-sample-s4b",
    name: "LiteAvatar Sample · S4b",
    width: WIDTH,
    height: HEIGHT,
    background: "opaque",
    cross_fade_ms: 110,
    mouth_gate: {
      close_delay_ms: 320,
      open_threshold: 0.018,
    },
    states: {
      idle: { file: "idle.mov", playback_rate: 1, start_offset_ms: 0 },
      listening: {
        file: "listening.mov",
        playback_rate: 1.06,
        start_offset_ms: 700,
      },
      thinking: {
        file: "thinking.mov",
        playback_rate: 0.86,
        start_offset_ms: 1700,
      },
      speaking: {
        file: "speaking.mov",
        playback_rate: 1,
        start_offset_ms: 0,
      },
    },
    source: {
      avatar: AVATAR_NAME,
      generator: PACK_GENERATOR,
      generator_version: PACK_GENERATOR_VERSION,
      project: "OpenAvatarChat / LiteAvatar",
    },
  };
  fs.writeFileSync(
    path.join(buildDirectory, "s4b.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const license = path.join(runtime.oacDirectory, "LICENSE");
  if (fs.existsSync(license)) {
    fs.copyFileSync(
      license,
      path.join(buildDirectory, "LICENSE-OpenAvatarChat.txt"),
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const output = path.resolve(options.output);
  const existing = resolveS4bPack({ candidates: [output] });
  const existingGeneratorVersion = personaGeneratorVersion(output);
  const shouldUpgrade =
    existing.available &&
    existingGeneratorVersion != null &&
    existingGeneratorVersion < PACK_GENERATOR_VERSION;
  if (existing.available && !options.force && !shouldUpgrade) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, output, reused: true, packId: existing.publicPack.id })}\n`,
    );
    return;
  }
  if (shouldUpgrade) {
    process.stdout.write(
      `Upgrading Persona S4b pack generator v${existingGeneratorVersion} to v${PACK_GENERATOR_VERSION}…\n`,
    );
  }
  if (fs.existsSync(output) && !options.force && !shouldUpgrade) {
    throw new Error(
      `${output} exists but is not a valid S4b pack. Pass --force to preserve it as a backup and rebuild.`,
    );
  }

  const runtime = resolveLiteAvatarRuntime({
    ...(options.runtime ? { candidates: [options.runtime] } : {}),
  });
  if (!runtime.available) {
    throw new Error(
      "LiteAvatar runtime is unavailable. Set PERSONA_LITEAVATAR_RUNTIME or pass --runtime.",
    );
  }
  const sourceDirectory = path.join(
    runtime.oacDirectory,
    "resource",
    "avatar",
    "liteavatar",
    AVATAR_NAME,
  );
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const buildDirectory = fs.mkdtempSync(path.join(parent, ".s4b-build-"));
  let installed = false;
  try {
    await buildPack({ buildDirectory, runtime, sourceDirectory });
    const prepared = resolveS4bPack({ candidates: [buildDirectory] });
    if (!prepared.available) {
      throw new Error(`Generated S4b pack failed validation: ${prepared.error}`);
    }
    let backup = null;
    if (fs.existsSync(output)) {
      backup = `${output}.backup-${Date.now()}`;
      fs.renameSync(output, backup);
    }
    fs.renameSync(buildDirectory, output);
    installed = true;
    process.stdout.write(
      `${JSON.stringify({
        backup,
        ok: true,
        output,
        packId: prepared.publicPack.id,
        reused: false,
      })}\n`,
    );
  } finally {
    if (!installed && fs.existsSync(buildDirectory)) {
      fs.rmSync(buildDirectory, { force: true, recursive: true });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  NEUTRAL_FRAME_COUNT,
  PACK_GENERATOR_VERSION,
  targetSpeechFrameCount,
};
