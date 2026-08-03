"use strict";

const readline = require("node:readline");

const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]).toString(
  "base64",
);

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.cmd === "init") {
    emit({ load_s: 0.01, ok: true });
    emit({ jpg: jpeg, sid: "", t: "v" });
  } else if (message.cmd === "audio") {
    emit({ jpg: jpeg, sid: message.sid, t: "v" });
  } else if (message.cmd === "interrupt") {
    emit({ status: "LISTENING", t: "s" });
  } else if (message.cmd === "stop") {
    input.close();
  }
});

input.on("close", () => process.exit(0));
