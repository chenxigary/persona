"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  defaultS4bPackDirectory,
  resolveS4bPack,
} = require("../electron/s4b-pack.cjs");

const projectRoot = path.join(__dirname, "..");
const electronPath = require("electron");
const SCREENSHOT_MIN_BYTES = 30_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(check, timeoutMs, message, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
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
            typeof event.data === "string" ? event.data : await event.data.text();
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
            const id = nextId++;
            return new Promise((commandResolve, commandReject) => {
              pending.set(id, { reject: commandReject, resolve: commandResolve });
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
      const surface = document.querySelector('[data-testid="s4b-avatar"]');
      const videos = [...(surface?.querySelectorAll('video') ?? [])].map((video) => ({
        currentTime: video.currentTime,
        duration: video.duration,
        error: video.error?.message ?? null,
        naturalHeight: video.videoHeight,
        naturalWidth: video.videoWidth,
        opacity: getComputedStyle(video).opacity,
        paused: video.paused,
        playbackRate: video.playbackRate,
        readyState: video.readyState,
        source: video.currentSrc,
        state: video.dataset.state,
        visible: video.classList.contains('is-visible'),
      }));
      const activeVideo = videos.find((video) => video.visible);
      const closedFrame = surface?.querySelector('[data-testid="s4b-speaking-closed-frame"]');
      const stage = surface?.querySelector('[data-testid="s4b-stage"]');
      const stageRect = stage?.getBoundingClientRect();
      return {
        active: surface?.classList.contains('is-active') ?? false,
        activeState: surface?.dataset.activeState ?? null,
        closedFrameOpacity: closedFrame ? getComputedStyle(closedFrame).opacity : null,
        closedFrameReady: surface?.dataset.closedFrameReady === 'true',
        mouthActive: surface?.dataset.mouthActive === 'true',
        mouthTransitionReason: surface?.dataset.mouthTransitionReason ?? null,
        opacity: surface ? getComputedStyle(surface).opacity : null,
        ready: surface?.dataset.ready === 'true',
        renderedHeight: stageRect?.height ?? 0,
        renderedWidth: stageRect?.width ?? 0,
        stageRect: stageRect ? {
          bottom: stageRect.bottom,
          height: stageRect.height,
          left: stageRect.left,
          right: stageRect.right,
          top: stageRect.top,
          width: stageRect.width,
        } : null,
        surfaceMode: surface?.dataset.surfaceMode ?? null,
        videos,
        visibleReadyState: activeVideo?.readyState ?? 0,
      };
    })()`,
    returnByValue: true,
  });
  return evaluation.result.value;
}

function voiceState(activity, phase = "active") {
  return {
    type: "state",
    state: {
      activity,
      microphoneMuted: false,
      outputMuted: false,
      phase,
    },
  };
}

async function postEvent(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/events`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 202);
}

async function waitForState(cdp, state, timeoutMs = 2_000) {
  return waitUntil(async () => {
    const surface = await inspectSurface(cdp);
    return surface.activeState === state && surface.visibleReadyState >= 2
      ? surface
      : null;
  }, timeoutMs, `S4b did not switch to ${state}`);
}

async function main() {
  const packDirectory = path.resolve(
    process.env.PERSONA_S4B_PACK || defaultS4bPackDirectory(),
  );
  const resolvedPack = resolveS4bPack({ candidates: [packDirectory] });
  assert.equal(
    resolvedPack.available,
    true,
    "Prepare the local S4b pack first with npm run s4b:prepare.",
  );
  const bridgePort = 47_833;
  const launchedAt = Date.now();
  const child = spawn(electronPath, ["--remote-debugging-port=0", projectRoot], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PERSONA_AVATAR_DRIVER: "s4b",
      PERSONA_BRIDGE_PORT: String(bridgePort),
      PERSONA_DEBUG: "1",
      PERSONA_DEBUG_LOG: path.join(
        os.tmpdir(),
        `persona-s4b-e2e-${process.pid}.log`,
      ),
      PERSONA_S4B_PACK: packDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let debugPort = null;
  const collect = (chunk) => {
    logs = `${logs}${chunk.toString("utf8")}`.slice(-50_000);
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
    await cdp.send("Page.enable");

    const initial = await waitUntil(async () => {
      const surface = await inspectSurface(cdp);
      return surface.active &&
        surface.ready &&
        surface.activeState === "idle" &&
        surface.opacity === "1" &&
        surface.visibleReadyState >= 2
        ? surface
        : null;
    }, 15_000, "S4b did not replace the VRM fallback in Electron");
    const startupMs = Date.now() - launchedAt;
    const prepared = await waitUntil(async () => {
      const surface = await inspectSurface(cdp);
      return surface.closedFrameReady && surface.closedFrameOpacity === "1"
        ? surface
        : null;
    }, 5_000, "S4b did not predecode its closed-mouth frame");
    const closedFrameReadyMs = Date.now() - launchedAt;
    assert.equal(initial.videos.length, 1);
    assert.equal(initial.surfaceMode, "single");
    assert.equal(prepared.closedFrameReady, true);
    assert.equal(initial.opacity, "1");
    assert.ok(initial.renderedWidth > 100);
    assert.ok(initial.renderedHeight > 300);
    assert.ok(initial.videos.every((video) => video.error == null));
    const stableSource = initial.videos[0].source;
    assert.equal(initial.videos[0].state, "speaking");
    assert.equal(initial.videos[0].paused, true);
    assert.equal(prepared.closedFrameOpacity, "1");

    await delay(250);
    const idleAdvanced = await inspectSurface(cdp);
    assert.ok(
      Math.abs(idleAdvanced.videos[0].currentTime - initial.videos[0].currentTime) < 0.04,
      "S4b neutral surface advanced its mouth while idle.",
    );

    const switchLatencies = {};
    for (const activity of ["listening", "thinking"]) {
      const started = Date.now();
      await postEvent(bridgePort, voiceState(activity));
      const surface = await waitForState(cdp, activity);
      switchLatencies[activity] = Date.now() - started;
      assert.equal(surface.active, true);
      assert.equal(surface.videos.length, 1);
      assert.equal(surface.videos[0].source, stableSource);
      assert.ok(switchLatencies[activity] <= 500);
    }

    await postEvent(bridgePort, voiceState("speaking"));
    await waitForState(cdp, "speaking");
    const mouthStarted = Date.now();
    await postEvent(bridgePort, { type: "audio-level", level: 0.65 });
    const opened = await waitUntil(async () => {
      const surface = await inspectSurface(cdp);
      const speaking = surface.videos.find((video) => video.state === "speaking");
      return surface.mouthActive && !speaking.paused ? surface : null;
    }, 1_000, "S4b speaking loop did not open");
    const mouthOpenMs = Date.now() - mouthStarted;
    assert.ok(mouthOpenMs <= 250, `S4b mouth took ${mouthOpenMs} ms to open.`);
    assert.equal(opened.activeState, "speaking");
    assert.equal(opened.mouthTransitionReason, "open-threshold");
    assert.equal(opened.videos.length, 1);
    assert.equal(opened.videos[0].source, stableSource);
    assert.ok(
      Math.abs(opened.stageRect.width - initial.stageRect.width) < 0.5 &&
        Math.abs(opened.stageRect.height - initial.stageRect.height) < 0.5,
      `S4b changed surface size when speech began: ${JSON.stringify({
        idle: initial.stageRect,
        speaking: opened.stageRect,
      })}`,
    );
    const openedSpeaking = opened.videos.find(
      (video) => video.state === "speaking",
    );
    assert.equal(
      openedSpeaking.playbackRate,
      resolvedPack.publicPack.clips.speaking.playbackRate,
      "audio level must not accelerate the authored speaking loop",
    );

    const bridgedLowLevelGaps = [];
    for (const durationMs of [80, 160, 240]) {
      await postEvent(bridgePort, { type: "audio-level", level: 0 });
      await delay(durationMs);
      const duringGap = await inspectSurface(cdp);
      assert.equal(
        duringGap.mouthActive,
        true,
        `S4b mouth stopped during a ${durationMs} ms sentence valley`,
      );
      assert.equal(duringGap.videos[0].paused, false);
      bridgedLowLevelGaps.push(durationMs);
      await postEvent(bridgePort, { type: "audio-level", level: 0.05 });
      await delay(30);
    }

    // Once open, quiet speech above the lower close threshold must refresh the
    // envelope even though it is below the threshold needed to open from rest.
    for (let index = 0; index < 5; index += 1) {
      await postEvent(bridgePort, { type: "audio-level", level: 0.01 });
      await delay(100);
    }
    const quietSpeech = await inspectSurface(cdp);
    assert.equal(quietSpeech.mouthActive, true);
    assert.equal(quietSpeech.videos[0].paused, false);

    // Force the decoder across its authored loop boundary while speech remains
    // active. A missing/failed `loop` used to be observationally indistinguishable
    // from a false mouth close during long replies.
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const video = document.querySelector('[data-testid="s4b-video-speaking"]');
        video.currentTime = Math.max(0, video.duration - 0.06);
      })()`,
    });
    await delay(220);
    const loopBoundary = await inspectSurface(cdp);
    assert.equal(loopBoundary.mouthActive, true);
    assert.equal(loopBoundary.videos[0].paused, false);
    assert.ok(
      loopBoundary.videos[0].currentTime < loopBoundary.videos[0].duration - 0.06,
      "S4b speaking video did not continue across its loop boundary",
    );

    const mouthStopped = Date.now();
    await postEvent(bridgePort, { type: "audio-level", level: 0 });
    const closed = await waitUntil(async () => {
      const surface = await inspectSurface(cdp);
      const speaking = surface.videos.find((video) => video.state === "speaking");
      return !surface.mouthActive && speaking.paused ? surface : null;
    }, 1_000, "S4b speaking loop did not close after silence", 10);
    const mouthCloseMs = Date.now() - mouthStopped;
    assert.ok(
      mouthCloseMs >= 280 && mouthCloseMs <= 500,
      `S4b mouth closed after ${mouthCloseMs} ms.`,
    );
    assert.equal(closed.activeState, "speaking");
    assert.equal(closed.mouthTransitionReason, "silence-envelope");

    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const speaking = document.querySelector('[data-testid="s4b-video-speaking"]');
        window.__personaS4bSeekCount = 0;
        speaking.addEventListener('seeking', () => {
          window.__personaS4bSeekCount += 1;
        });
      })()`,
    });
    const silenceSamples = [];
    for (let index = 0; index < 24; index += 1) {
      // A real Core Audio meter emits small, changing values roughly every
      // 33ms. The old renderer sought the visible speaking video back to zero
      // for every one of these events after its short mouth-close gate fired.
      await postEvent(bridgePort, {
        type: "audio-level",
        level: index % 2 === 0 ? 0.001 : 0.006,
      });
      await delay(33);
      if (index % 2 !== 0) continue;
      const [surface, screenshot] = await Promise.all([
        inspectSurface(cdp),
        cdp.send("Page.captureScreenshot", {
          captureBeyondViewport: false,
          format: "png",
        }),
      ]);
      silenceSamples.push({
        bytes: Buffer.from(screenshot.data, "base64").length,
        surface,
      });
    }
    const seekProbe = await cdp.send("Runtime.evaluate", {
      expression: "window.__personaS4bSeekCount",
      returnByValue: true,
    });
    assert.equal(
      seekProbe.result.value,
      0,
      "high-frequency silence events repeatedly sought the speaking video",
    );
    const closedAfterMeter = await inspectSurface(cdp);
    assert.equal(closedAfterMeter.closedFrameReady, true);
    assert.equal(closedAfterMeter.closedFrameOpacity, "1");
    assert.equal(closedAfterMeter.mouthActive, false);

    const samples = [...silenceSamples];
    for (let index = 0; index < 30; index += 1) {
      if (index === 5) await postEvent(bridgePort, voiceState("listening"));
      if (index === 15) await postEvent(bridgePort, voiceState("thinking"));
      if (index === 24) await postEvent(bridgePort, voiceState("idle", "inactive"));
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
      samples.push({ bytes: png.length, surface });
    }
    const screenshotPath = path.join(
      os.tmpdir(),
      `persona-s4b-electron-${process.pid}.png`,
    );
    const smallest = samples.reduce((left, right) =>
      right.bytes < left.bytes ? right : left,
    );
    const finalScreenshot = await cdp.send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      format: "png",
    });
    fs.writeFileSync(screenshotPath, Buffer.from(finalScreenshot.data, "base64"));
    assert.ok(
      smallest.bytes > SCREENSHOT_MIN_BYTES,
      `S4b surface flickered blank; diagnostic screenshot: ${screenshotPath}`,
    );
    const invalidSamples = samples
      .map(({ surface }, index) => ({ index, surface }))
      .filter(
        ({ surface }) =>
          !surface.active ||
          surface.visibleReadyState < 2 ||
          surface.opacity !== "1" ||
          surface.videos.length !== 1 ||
          surface.videos[0].source !== stableSource,
      );
    assert.equal(
      invalidSamples.length,
      0,
      `S4b lost its decoded visible surface during state transitions: ${JSON.stringify(invalidSamples)}`,
    );
    const final = await waitForState(cdp, "idle");
    assert.equal(final.mouthActive, false);
    assert.equal(final.videos.length, 1);
    assert.equal(final.videos[0].source, stableSource);

    // A corner resize owns the frame until pointerup. The regression cleared
    // hover on blur/mouseout, turned macOS pass-through back on, and cancelled
    // the user's drag midway through the first movement.
    const stagePoint = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const rect = document.querySelector('[data-testid="s4b-stage"]').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: stagePoint.result.value.x,
      y: stagePoint.result.value.y,
    });
    const frameVisible = await waitUntil(async () => {
      const probe = await cdp.send("Runtime.evaluate", {
        expression:
          "document.querySelector('[data-testid=\"character-frame\"]')?.classList.contains('is-visible') ?? false",
        returnByValue: true,
      });
      return probe.result.value;
    }, 1_000, "S4b character frame did not appear on hover");
    assert.equal(frameVisible, true);

    // Reproduce the real macOS failure point: app-region can produce a null
    // relatedTarget mouseout before pointerdown. Main-process screen-coordinate
    // ownership must keep the chrome alive long enough to reach the toolbar.
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        document.dispatchEvent(new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: null,
        }));
        window.dispatchEvent(new Event('blur'));
      })()`,
    });
    await delay(100);
    const frameBeforePointerDown = await cdp.send("Runtime.evaluate", {
      expression:
        "document.querySelector('[data-testid=\"character-frame\"]')?.classList.contains('is-visible') ?? false",
      returnByValue: true,
    });
    assert.equal(
      frameBeforePointerDown.result.value,
      true,
      "frame disappeared during the person-to-app-region handoff",
    );
    const cornerPoint = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const rect = document.querySelector('.character-frame__corner--se').getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      button: "left",
      buttons: 1,
      clickCount: 1,
      type: "mousePressed",
      x: cornerPoint.result.value.x,
      y: cornerPoint.result.value.y,
    });
    await cdp.send("Runtime.evaluate", {
      expression: "window.dispatchEvent(new Event('blur'))",
    });
    const heldFrame = await cdp.send("Runtime.evaluate", {
      expression:
        "document.querySelector('[data-testid=\"character-frame\"]')?.classList.contains('is-visible') ?? false",
      returnByValue: true,
    });
    assert.equal(heldFrame.result.value, true, "frame disappeared during resize gesture");
    await cdp.send("Input.dispatchMouseEvent", {
      button: "left",
      buttons: 0,
      clickCount: 1,
      type: "mouseReleased",
      x: cornerPoint.result.value.x,
      y: cornerPoint.result.value.y,
    });

    const beforeDrag = await cdp.send("Runtime.evaluate", {
      expression: "({ left: window.screenX, top: window.screenY })",
      returnByValue: true,
    });
    await cdp.send("Runtime.evaluate", {
      expression: "window.moveBy(40, 20)",
    });
    const afterDrag = await waitUntil(async () => {
      const probe = await cdp.send("Runtime.evaluate", {
        expression: "({ left: window.screenX, top: window.screenY })",
        returnByValue: true,
      });
      return probe.result.value.left !== beforeDrag.result.value.left ||
        probe.result.value.top !== beforeDrag.result.value.top
        ? probe.result.value
        : null;
    }, 1_000, "macOS BrowserWindow did not report its movement");
    await cdp.send("Runtime.evaluate", {
      expression: "window.dispatchEvent(new Event('blur'))",
    });
    await delay(40);
    const frameAfterDrag = await cdp.send("Runtime.evaluate", {
      expression:
        "document.querySelector('[data-testid=\"character-frame\"]')?.classList.contains('is-visible') ?? false",
      returnByValue: true,
    });
    assert.equal(frameAfterDrag.result.value, true, "frame disappeared after window drag");
    assert.ok(afterDrag.left !== beforeDrag.result.value.left);

    // The explicit adjustment mode is the reliable fallback when native
    // app-region behavior changes. It pins both the frame and interaction until
    // the user finishes or presses Escape.
    await cdp.send("Runtime.evaluate", {
      expression: "window.personaBridge.setFrameAdjustmentMode(true)",
    });
    await delay(80);
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        document.dispatchEvent(new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: null,
        }));
        window.dispatchEvent(new Event('blur'));
      })()`,
    });
    await delay(300);
    const pinnedAdjustmentFrame = await cdp.send("Runtime.evaluate", {
      expression:
        "document.querySelector('[data-testid=\"character-frame\"]')?.classList.contains('is-visible') ?? false",
      returnByValue: true,
    });
    assert.equal(
      pinnedAdjustmentFrame.result.value,
      true,
      "explicit adjustment mode did not pin the frame",
    );
    await cdp.send("Runtime.evaluate", {
      expression:
        "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))",
    });
    const health = await fetch(`http://127.0.0.1:${bridgePort}/health`).then(
      (response) => response.json(),
    );
    assert.equal(health.ok, true);

    console.log(
      JSON.stringify({
        mouthCloseMs,
        mouthOpenMs,
        ok: true,
        packDirectory,
        closedFrameReadyMs,
        screenshotMinBytes: smallest.bytes,
        screenshotPath,
        silenceSeekCount: seekProbe.result.value,
        silenceSamples: silenceSamples.length,
        frameMoveLatch: true,
        framePrePointerHandoff: true,
        adjustmentModeFallback: true,
        bridgedLowLevelGaps,
        loopBoundaryPlayback: true,
        singleSurfaceSource: true,
        startupMs,
        surface: "s4b",
        switchLatencies,
        transitionSamples: samples.length - silenceSamples.length,
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
