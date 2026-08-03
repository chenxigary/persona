"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.join(__dirname, "..");
const electronPath = require("electron");
const SCREENSHOT_MIN_BYTES = 30_000;
const SCREENSHOT_SAMPLE_COUNT = 48;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener("error", () => reject(new Error("CDP socket failed.")), {
      once: true,
    });
    socket.addEventListener(
      "open",
      () => {
        socket.addEventListener("message", async (event) => {
          const text =
            typeof event.data === "string"
              ? event.data
              : await event.data.text();
          const message = JSON.parse(text);
          if (message.id == null) return;
          const callbacks = pending.get(message.id);
          if (!callbacks) return;
          pending.delete(message.id);
          if (message.error) callbacks.reject(new Error(message.error.message));
          else callbacks.resolve(message.result);
        });
        resolve({
          close: () => socket.close(),
          send(method, params = {}) {
            const id = nextId;
            nextId += 1;
            return new Promise((commandResolve, commandReject) => {
              pending.set(id, {
                reject: commandReject,
                resolve: commandResolve,
              });
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
        });
      },
      { once: true },
    );
  });
}

async function inspectSurface(cdp) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const surface = document.querySelector('[data-testid="realistic-avatar"]');
      const canvas = surface?.querySelector('[data-testid="realistic-avatar-canvas"]');
      const frameSequence = Number(canvas?.dataset.frameSequence ?? 0);
      return {
        active: surface?.classList.contains('is-active') ?? false,
        canvasCount: document.querySelectorAll('canvas').length,
        complete: frameSequence > 0,
        frameSequence,
        naturalHeight: canvas?.height ?? 0,
        naturalWidth: canvas?.width ?? 0,
        opacity: surface ? getComputedStyle(surface).opacity : null,
        renderedHeight: canvas?.getBoundingClientRect().height ?? 0,
        renderedWidth: canvas?.getBoundingClientRect().width ?? 0,
        source: canvas?.dataset.source || null,
      };
    })()`,
    returnByValue: true,
  });
  return evaluation.result.value;
}

async function captureContinuousSurface(cdp) {
  const samples = [];
  let smallestPng = null;
  for (let index = 0; index < SCREENSHOT_SAMPLE_COUNT; index += 1) {
    await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: "new Promise((resolve) => requestAnimationFrame(resolve))",
    });
    const [surface, screenshot] = await Promise.all([
      inspectSurface(cdp),
      cdp.send("Page.captureScreenshot", {
        captureBeyondViewport: false,
        format: "png",
      }),
    ]);
    const png = Buffer.from(screenshot.data, "base64");
    if (!smallestPng || png.length < smallestPng.length) smallestPng = png;
    samples.push({
      bytes: png.length,
      source: surface.source,
    });
  }
  return { samples, smallestPng };
}

async function main() {
  const bridgePort = 47_832;
  const child = spawn(
    electronPath,
    ["--remote-debugging-port=0", projectRoot],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PERSONA_AVATAR_DRIVER: "liteavatar",
        PERSONA_BRIDGE_PORT: String(bridgePort),
        PERSONA_DEBUG: "1",
        PERSONA_DEBUG_LOG: path.join(
          os.tmpdir(),
          `persona-liteavatar-e2e-${process.pid}.log`,
        ),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  let debugPort = null;
  const collect = (chunk) => {
    logs = `${logs}${chunk.toString("utf8")}`.slice(-40_000);
    const match = logs.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) debugPort = Number(match[1]);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let cdp = null;

  try {
    await waitUntil(
      () => debugPort,
      10_000,
      "Electron did not expose its local debug endpoint",
    );
    const target = await waitUntil(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (!response.ok) return null;
      const targets = await response.json();
      return targets.find(
        (candidate) =>
          candidate.type === "page" &&
          !candidate.url.includes("view=settings") &&
          candidate.webSocketDebuggerUrl,
      );
    }, 15_000, "Persona's avatar renderer did not open");
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    const surface = await waitUntil(async () => {
      const value = await inspectSurface(cdp);
      return value.active && value.complete && value.naturalWidth > 0
        ? value
        : null;
    }, 60_000, "LiteAvatar did not replace the VRM fallback in Electron");

    assert.equal(surface.canvasCount, 1);
    assert.equal(surface.naturalWidth, 448);
    assert.equal(surface.naturalHeight, 960);
    assert.equal(surface.opacity, "1");
    assert.ok(surface.renderedWidth > 100);
    assert.ok(surface.renderedHeight > 300);
    assert.match(surface.source, /^persona-avatar:\/\/frame\/\d+$/);
    const { samples, smallestPng } = await captureContinuousSurface(cdp);
    const screenshotPath = path.join(
      os.tmpdir(),
      `persona-liteavatar-electron-${process.pid}.png`,
    );
    const blankSamples = samples.filter(
      (sample) => sample.bytes <= SCREENSHOT_MIN_BYTES,
    );
    const presentedFrames = new Set(samples.map((sample) => sample.source));
    fs.writeFileSync(screenshotPath, smallestPng);
    assert.equal(
      blankSamples.length,
      0,
      `Rendered surface flickered blank in ${blankSamples.length}/${samples.length} samples; smallest screenshot saved to ${screenshotPath}.`,
    );
    assert.ok(
      presentedFrames.size >= 3,
      `Rendered surface stopped advancing (${presentedFrames.size} distinct frame sources).`,
    );
    const health = await fetch(`http://127.0.0.1:${bridgePort}/health`).then(
      (response) => response.json(),
    );
    assert.equal(health.ok, true);
    console.log(
      JSON.stringify({
        naturalHeight: surface.naturalHeight,
        naturalWidth: surface.naturalWidth,
        ok: true,
        renderedHeight: Math.round(surface.renderedHeight),
        renderedWidth: Math.round(surface.renderedWidth),
        screenshotMinBytes: Math.min(...samples.map((sample) => sample.bytes)),
        screenshotPath,
        screenshotSamples: samples.length,
        uniqueFrameSources: presentedFrames.size,
        surface: "liteavatar",
      }),
    );
    await cdp.send("Browser.close");
    await Promise.race([exited, delay(5_000)]);
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    cdp?.close();
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(3_000).then(() => false),
      ]);
      if (!stopped) child.kill("SIGKILL");
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
