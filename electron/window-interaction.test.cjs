"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  WindowInteractionController,
  applyInteractionToWindow,
  normalizeInteractionMode,
  shouldIgnoreMouseEvents,
} = require("./window-interaction.cjs");

test("auto mode only accepts the pointer over the character", () => {
  assert.equal(shouldIgnoreMouseEvents({ mode: "auto", pointerOverCharacter: false }), true);
  assert.equal(shouldIgnoreMouseEvents({ mode: "auto", pointerOverCharacter: true }), false);
});

test("always mode keeps the window interactive everywhere", () => {
  assert.equal(shouldIgnoreMouseEvents({ mode: "always", pointerOverCharacter: false }), false);
  assert.equal(shouldIgnoreMouseEvents({ mode: "always", pointerOverCharacter: true }), false);
});

test("an unknown mode falls back to pass-through rather than blocking clicks", () => {
  assert.equal(normalizeInteractionMode("nonsense"), "auto");
  assert.equal(shouldIgnoreMouseEvents({ mode: "nonsense" }), true);
  assert.equal(shouldIgnoreMouseEvents(), true);
});

test("the controller reports only genuine changes", () => {
  const controller = new WindowInteractionController();
  // First resolve must emit so a freshly created window is made click-through.
  assert.equal(controller.resolve(), true);
  assert.equal(controller.resolve(), null);

  assert.equal(controller.setPointerOverCharacter(true), false);
  assert.equal(controller.setPointerOverCharacter(true), null);
  assert.equal(controller.setPointerOverCharacter(false), true);
});

test("switching to always interactive releases pass-through immediately", () => {
  const controller = new WindowInteractionController();
  controller.resolve();
  assert.equal(controller.setMode("always"), false);
  // Pointer movement no longer changes anything while pinned interactive.
  assert.equal(controller.setPointerOverCharacter(false), null);
  assert.equal(controller.setMode("auto"), true);
});

test("reset re-emits because a recreated window starts interactive", () => {
  const controller = new WindowInteractionController();
  controller.resolve();
  assert.equal(controller.resolve(), null);
  controller.reset();
  assert.equal(controller.resolve(), true);
});

test("applying forwards mouse events so the renderer keeps tracking the pointer", () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    setIgnoreMouseEvents: (ignore, options) => calls.push([ignore, options]),
  };
  assert.equal(applyInteractionToWindow(window, true), true);
  assert.deepEqual(calls, [[true, { forward: true }]]);
});

test("applying is a no-op without a change or a live window", () => {
  const window = {
    isDestroyed: () => false,
    setIgnoreMouseEvents: () => assert.fail("must not be called"),
  };
  assert.equal(applyInteractionToWindow(window, null), false);
  assert.equal(applyInteractionToWindow(null, true), false);
  assert.equal(
    applyInteractionToWindow(
      { isDestroyed: () => true, setIgnoreMouseEvents: () => assert.fail("destroyed") },
      true,
    ),
    false,
  );
});
