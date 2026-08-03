"use strict";

const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LITEAVATAR_DRIVER_ID,
  createAvatarDriverHost,
} = require("../electron/avatar-driver.cjs");
const {
  LiteAvatarAdapter,
  createLiteAvatarFrameResponse,
  resolveLiteAvatarRuntime,
  validJpeg,
} = require("../electron/liteavatar-adapter.cjs");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function voiceState(activity) {
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

function readWave(filePath) {
  const wave = fs.readFileSync(filePath);
  assert.equal(wave.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wave.subarray(8, 12).toString("ascii"), "WAVE");
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
  assert.ok(format, "WAV format chunk is missing.");
  assert.ok(data?.length, "WAV audio data is missing.");
  assert.deepEqual(
    {
      bitsPerSample: format.bitsPerSample,
      channels: format.channels,
      encoding: format.encoding,
    },
    { bitsPerSample: 16, channels: 1, encoding: 1 },
    "E2E input must be mono PCM s16le.",
  );
  return { data, sampleRate: format.sampleRate };
}

function jpegDimensions(jpeg) {
  for (let offset = 2; offset + 9 < jpeg.length; ) {
    if (jpeg[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = jpeg[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7].includes(marker)) {
      return {
        height: jpeg.readUInt16BE(offset + 5),
        width: jpeg.readUInt16BE(offset + 7),
      };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (offset + 4 > jpeg.length) break;
    const length = jpeg.readUInt16BE(offset + 2);
    if (length < 2) break;
    offset += 2 + length;
  }
  return null;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function waitForHeartbeat(adapter, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = adapter.getStatus();
    if (status.fps != null && status.rssMb != null) return status;
    await delay(100);
  }
  throw new Error("Timed out waiting for the LiteAvatar health heartbeat.");
}

async function main() {
  if (process.env.PERSONA_LITEAVATAR_E2E !== "1") {
    throw new Error(
      "Real model E2E is opt-in. Run through npm run test:liteavatar:e2e.",
    );
  }
  const runtime = resolveLiteAvatarRuntime();
  assert.equal(
    runtime.available,
    true,
    "LiteAvatar runtime is unavailable. Set PERSONA_LITEAVATAR_RUNTIME.",
  );
  const wavePath =
    process.env.PERSONA_LITEAVATAR_TEST_WAV ||
    path.join(
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
  const wave = readWave(wavePath);
  const frameTimes = [];
  const idleFrameHashes = new Set();
  const speechFrameHashes = new Set();
  let audioStartedAt;
  let firstSpeechFrameAt = null;
  const adapter = new LiteAvatarAdapter({
    onDebug: (...details) => {
      if (process.env.PERSONA_DEBUG === "1") {
        console.error("[liteavatar-e2e]", ...details);
      }
    },
    onFrame: ({ sid }) => {
      const now = Date.now();
      frameTimes.push(now);
      if (sid && firstSpeechFrameAt == null) firstSpeechFrameAt = now;
    },
    runtime,
  });
  adapter.on("frame", ({ sid }) => {
    const jpeg = adapter.getFrame()?.jpeg;
    if (!jpeg) return;
    const hash = nodeCrypto.createHash("sha256").update(jpeg).digest("hex");
    (sid ? speechFrameHashes : idleFrameHashes).add(hash);
  });
  const driver = createAvatarDriverHost({
    adapter,
    driverId: LITEAVATAR_DRIVER_ID,
  });

  try {
    assert.equal(driver.start(), true);
    const ready = await adapter.waitUntilReady(240_000);
    assert.equal(ready.phase, "ready");
    const idleFrame = await adapter.waitForFrame({ timeoutMs: 30_000 });
    assert.equal(validJpeg(idleFrame.jpeg), true);

    driver.handleEvent(voiceState("speaking"));
    audioStartedAt = Date.now();
    const chunkFrames = Math.round(wave.sampleRate * 0.02);
    const chunkBytes = chunkFrames * 2;
    let sequence = 0;
    for (let offset = 0; offset < wave.data.length; offset += chunkBytes) {
      const data = Buffer.from(wave.data.subarray(offset, offset + chunkBytes));
      assert.equal(
        driver.handlePcm({
          channels: 1,
          data,
          encoding: "s16le",
          frames: data.length / 2,
          sampleRate: wave.sampleRate,
          sequence,
        }),
        true,
      );
      sequence += 1;
      await delay(20);
    }
    await driver.flushPcm();
    driver.handleEvent(voiceState("listening"));
    const speechFrame = await adapter.waitForFrame({
      afterSequence: idleFrame.sequence,
      speechOnly: true,
      timeoutMs: 60_000,
    });
    await delay(300);
    const health = await waitForHeartbeat(adapter);
    const response = createLiteAvatarFrameResponse(
      adapter,
      `persona-avatar://frame/${speechFrame.sequence}`,
    );
    assert.equal(response.status, 200);
    const jpeg = Buffer.from(await response.arrayBuffer());
    assert.equal(validJpeg(jpeg), true);
    assert.deepEqual(jpegDimensions(jpeg), {
      height: health.height,
      width: health.width,
    });

    const intervals = frameTimes
      .slice(1)
      .map((time, index) => time - frameTimes[index])
      .filter((interval) => interval < 1000);
    const p95FrameIntervalMs = percentile(intervals, 0.95);
    const firstSpeechFrameMs = firstSpeechFrameAt - audioStartedAt;
    assert.ok(health.frames >= 30, `Only ${health.frames} frames were produced.`);
    assert.ok(
      health.speechFrames >= 1,
      "No audio-driven LiteAvatar frame was produced.",
    );
    assert.ok(
      speechFrameHashes.size >= 3,
      `Only ${speechFrameHashes.size} distinct speech images were produced.`,
    );
    assert.ok(
      [...speechFrameHashes].some((hash) => !idleFrameHashes.has(hash)),
      "Speech frames were identical to every observed idle frame.",
    );
    assert.ok(health.fps >= 15, `LiteAvatar heartbeat was only ${health.fps} fps.`);
    assert.ok(
      p95FrameIntervalMs != null && p95FrameIntervalMs <= 150,
      `LiteAvatar p95 frame interval was ${p95FrameIntervalMs} ms.`,
    );
    assert.ok(
      firstSpeechFrameMs >= 0 && firstSpeechFrameMs <= 3_000,
      `First speech frame took ${firstSpeechFrameMs} ms.`,
    );
    assert.ok(health.rssMb <= 6_144, `LiteAvatar RSS was ${health.rssMb} MB.`);
    assert.ok(
      health.swapDeltaMb == null || health.swapDeltaMb <= 512,
      `System swap grew by ${health.swapDeltaMb} MB during the run.`,
    );
    const queue = driver.getStatus().pcm;
    assert.equal(queue.failedChunks, 0);
    assert.equal(queue.droppedChunks, 0);
    const expectedAvatarBytes = Math.round(
      (wave.data.length / 2 / wave.sampleRate) * health.sampleRate * 2,
    );
    assert.ok(
      Math.abs(health.audioSentBytes - expectedAvatarBytes) <=
        health.sampleRate * 0.1 * 2,
      `Resampled audio duration drifted: sent ${health.audioSentBytes} bytes, expected ${expectedAvatarBytes}.`,
    );

    const previewPath = path.join(
      os.tmpdir(),
      `persona-liteavatar-e2e-${process.pid}.jpg`,
    );
    fs.writeFileSync(previewPath, jpeg);
    console.log(
      JSON.stringify({
        audioInputSeconds: Number(
          (wave.data.length / 2 / wave.sampleRate).toFixed(2),
        ),
        audioSentBytes: health.audioSentBytes,
        firstSpeechFrameMs,
        fps: health.fps,
        frames: health.frames,
        loadSeconds: health.loadSeconds,
        ok: true,
        p95FrameIntervalMs,
        previewPath,
        rssMb: health.rssMb,
        speechFrames: health.speechFrames,
        uniqueSpeechImages: speechFrameHashes.size,
        swapDeltaMb: health.swapDeltaMb,
      }),
    );
  } finally {
    await driver.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
