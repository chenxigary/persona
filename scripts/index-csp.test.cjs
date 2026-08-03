"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

function getDirective(name) {
  const indexPath = path.join(__dirname, "..", "index.html");
  const index = fs.readFileSync(indexPath, "utf8");
  const policy = index.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  )?.[1];

  assert.ok(policy, "index.html must define a Content Security Policy");
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${name} `));
}

const getConnectSource = () => getDirective("connect-src");

test("allows embedded VRM textures to load through blob fetches", () => {
  const connectSource = getConnectSource();
  assert.ok(connectSource, "Content Security Policy must define connect-src");
  assert.match(connectSource, /(?:^|\s)blob:(?:\s|$)/);
});

test("allows the bundled reflection environment to load through a data fetch", () => {
  const connectSource = getConnectSource();
  assert.ok(connectSource, "Content Security Policy must define connect-src");
  assert.match(connectSource, /(?:^|\s)data:(?:\s|$)/);
});

test("allows only Persona's local asset protocol for imported character media", () => {
  const connectSource = getConnectSource();
  assert.ok(connectSource, "Content Security Policy must define connect-src");
  assert.match(connectSource, /(?:^|\s)persona-asset:(?:\s|$)/);
});

test("allows LiteAvatar frames only as local image content", () => {
  const imageSource = getDirective("img-src");
  const connectSource = getConnectSource();
  assert.ok(imageSource, "Content Security Policy must define img-src");
  assert.ok(connectSource, "Content Security Policy must define connect-src");
  assert.match(imageSource, /(?:^|\s)persona-avatar:(?:\s|$)/);
  assert.doesNotMatch(connectSource, /(?:^|\s)persona-avatar:(?:\s|$)/);
});

test("allows S4b clips only as local media content", () => {
  const mediaSource = getDirective("media-src");
  const connectSource = getConnectSource();
  assert.ok(mediaSource, "Content Security Policy must define media-src");
  assert.ok(connectSource, "Content Security Policy must define connect-src");
  assert.match(mediaSource, /(?:^|\s)persona-s4b:(?:\s|$)/);
  assert.doesNotMatch(connectSource, /(?:^|\s)persona-s4b:(?:\s|$)/);
});
