#!/usr/bin/env node
"use strict";

/**
 * Minimal end-to-end check of Persona's External voice-source contract.
 *
 * The bundled listeners identify a voice application by process name and then
 * attach a platform audio capture to it. That path is fragile by construction:
 * it depends on another vendor's internal process layout, and on macOS a
 * process tap can interfere with the very session it is trying to observe.
 *
 * The External contract avoids all of it. Any pipeline that already knows when
 * the assistant is speaking can post normalised state and levels to Persona's
 * loopback endpoint, with no process matching and no audio capture at all.
 * This script exercises that contract so the escape hatch is known to work
 * before it is needed.
 *
 * Usage:
 *   node scripts/check-external-events.cjs            # run the check
 *   node scripts/check-external-events.cjs --speak 8  # 8 seconds of speech
 *
 * Persona must be running with Settings -> Voice set to External.
 */

const DEFAULT_PORT = 47831;
const FRAME_INTERVAL_MS = 60;

function parseArguments(argv) {
  const options = { port: Number(process.env.PERSONA_BRIDGE_PORT) || DEFAULT_PORT, speakSeconds: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port" && index + 1 < argv.length) {
      const port = Number(argv[++index]);
      if (Number.isInteger(port) && port > 0 && port < 65536) options.port = port;
    }
    if (argv[index] === "--speak" && index + 1 < argv.length) {
      const seconds = Number(argv[++index]);
      if (Number.isFinite(seconds) && seconds > 0) options.speakSeconds = Math.min(seconds, 120);
    }
  }
  return options;
}

function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function voiceState(activity, phase = "active") {
  return {
    type: "state",
    state: {
      phase,
      activity,
      microphoneMuted: false,
      outputMuted: false,
    },
  };
}

/**
 * Synthesised speech envelope: a slow syllable rhythm with a little jitter, so
 * the character's mouth and body move the way they would on real audio rather
 * than sitting at a constant level.
 */
function speechLevel(elapsedMs) {
  const seconds = elapsedMs / 1000;
  const syllable = Math.abs(Math.sin(seconds * 7.5));
  const phrase = 0.55 + 0.45 * Math.sin(seconds * 0.9);
  const jitter = 0.08 * Math.sin(seconds * 23.1);
  return Math.max(0, Math.min(1, syllable * phrase + jitter));
}

async function postEvent(port, payload) {
  const response = await fetch(`${baseUrl(port)}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `POST /events rejected ${payload.type} with HTTP ${response.status}. ` +
        (response.status === 403
          ? "The request origin is not trusted; run this from a shell rather than a browser."
          : "Check that the payload matches docs/INTEGRATIONS.md."),
    );
  }
  return response;
}

async function readHealth(port) {
  const response = await fetch(`${baseUrl(port)}/health`);
  if (!response.ok) throw new Error(`GET /health returned HTTP ${response.status}.`);
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function main() {
  const { port, speakSeconds } = parseArguments(process.argv.slice(2));

  log(`Persona External contract check on ${baseUrl(port)}`);

  let health;
  try {
    health = await readHealth(port);
  } catch (error) {
    throw new Error(
      `Persona is not reachable on ${baseUrl(port)}. Start Persona first, or pass ` +
        `--port if PERSONA_BRIDGE_PORT was changed. (${error.message})`,
      { cause: error },
    );
  }
  if (!health?.ok) throw new Error("GET /health did not report ok.");
  log("  health          ok");

  await postEvent(port, voiceState("listening"));
  log("  state:listening accepted");
  await sleep(900);

  await postEvent(port, voiceState("speaking"));
  log(`  state:speaking  accepted, streaming levels for ${speakSeconds}s`);

  const started = Date.now();
  let frames = 0;
  while (Date.now() - started < speakSeconds * 1000) {
    await postEvent(port, {
      type: "audio-level",
      level: speechLevel(Date.now() - started),
    });
    frames += 1;
    await sleep(FRAME_INTERVAL_MS);
  }
  log(`  audio-level     accepted, ${frames} frames`);

  await postEvent(port, { type: "audio-level", level: 0 });
  await postEvent(port, voiceState("listening"));
  await sleep(600);
  await postEvent(port, voiceState("idle", "inactive"));
  log("  state:idle      accepted");

  const finalHealth = await readHealth(port);
  const activity = finalHealth?.lastState?.activity;
  if (activity !== "idle") {
    throw new Error(
      `Persona reports activity "${activity}" after the run; expected "idle". ` +
        "The events were accepted but did not reach the renderer state.",
    );
  }

  log("");
  log("External contract OK. Persona accepted state and level events with no");
  log("process matching and no audio capture. If the character did not animate,");
  log("check that Settings -> Voice is set to External and a model is imported.");
}

main().catch((error) => {
  process.stderr.write(`\nExternal contract check failed: ${error.message}\n`);
  process.exitCode = 1;
});
