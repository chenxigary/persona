"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { execFile } = require("node:child_process");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "check-external-events.cjs");

function startFakePersona({ rejectOrigin = false } = {}) {
  const received = [];
  let lastState = null;
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, lastState }));
      return;
    }
    if (request.method === "POST" && request.url === "/events") {
      if (rejectOrigin) {
        response.writeHead(403);
        response.end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body);
        received.push(payload);
        if (payload.type === "state") lastState = payload.state;
        response.writeHead(202);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ received, server, port: server.address().port }),
    );
  });
}

function runScript(port, extra = []) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, "--port", String(port), ...extra],
      { encoding: "utf8", timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

test("drives a full listening, speaking and idle cycle over the loopback API", async (t) => {
  const { received, server, port } = await startFakePersona();
  t.after(() => server.close());

  const { code, stdout } = await runScript(port, ["--speak", "0.4"]);
  assert.equal(code, 0, stdout);

  const states = received
    .filter((event) => event.type === "state")
    .map((event) => event.state.activity);
  assert.deepEqual(states, ["listening", "speaking", "listening", "idle"]);

  const levels = received
    .filter((event) => event.type === "audio-level")
    .map((event) => event.level);
  assert.ok(levels.length >= 2, "expected a stream of level frames");
  assert.ok(
    levels.every((level) => level >= 0 && level <= 1),
    "levels must stay inside the normalised range",
  );
  assert.ok(
    levels.some((level) => level > 0.2),
    "a speech envelope must actually rise, not sit at zero",
  );
  assert.equal(levels.at(-1), 0, "the run must release the mouth at the end");

  // Every state event has to match the documented contract exactly, otherwise
  // the real bridge rejects it.
  for (const event of received.filter((entry) => entry.type === "state")) {
    assert.deepEqual(Object.keys(event.state).sort(), [
      "activity",
      "microphoneMuted",
      "outputMuted",
      "phase",
    ]);
    assert.ok(["inactive", "starting", "active", "stopping"].includes(event.state.phase));
    assert.ok(["idle", "listening", "speaking"].includes(event.state.activity));
  }
});

test("reports a clear failure when Persona is not listening", async () => {
  const { server, port } = await startFakePersona();
  await new Promise((resolve) => server.close(resolve));

  const { code, stderr } = await runScript(port, ["--speak", "0.2"]);
  assert.equal(code, 1);
  assert.match(stderr, /not reachable/);
});

test("explains a rejected origin instead of failing opaquely", async (t) => {
  const { server, port } = await startFakePersona({ rejectOrigin: true });
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, ["--speak", "0.2"]);
  assert.equal(code, 1);
  assert.match(stderr, /HTTP 403/);
});
