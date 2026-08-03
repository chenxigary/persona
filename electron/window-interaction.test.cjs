"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FramePointerHandoff,
  WindowInteractionController,
  applyInteractionToWindow,
  normalizeInteractionMode,
  shouldIgnoreMouseEvents,
} = require("./window-interaction.cjs");

test("main-process frame handoff survives the person-to-toolbar transition", () => {
  const handoff = new FramePointerHandoff({ leaveDelayMs: 220 });
  const acquired = handoff.setFrameRect({
    left: 100,
    top: 150,
    right: 300,
    bottom: 600,
  });
  assert.equal(acquired.held, true);
  assert.equal(acquired.changed, true);
  const bounds = { x: 1_000, y: 200, width: 430, height: 680 };

  const entered = handoff.sample({
    bounds,
    cursor: { x: 1_200, y: 360 },
    now: 1_000,
  });
  assert.equal(entered.held, true);
  assert.equal(entered.changed, false);
  assert.deepEqual(entered.point, { x: 200, y: 160 });

  // This point is in the toolbar above the character. It remains inside the
  // renderer-reported frame even if Chromium emits mouseout for app-region.
  const toolbar = handoff.sample({
    bounds,
    cursor: { x: 1_200, y: 355 },
    now: 1_033,
  });
  assert.equal(toolbar.inside, true);
  assert.equal(toolbar.held, true);
  assert.equal(toolbar.changed, false);
});

test("frame handoff releases only after the screen cursor stays outside", () => {
  const handoff = new FramePointerHandoff({ leaveDelayMs: 220 });
  handoff.setFrameRect({ left: 100, top: 100, right: 300, bottom: 600 });
  const bounds = { x: 500, y: 100, width: 430, height: 680 };
  handoff.sample({ bounds, cursor: { x: 700, y: 400 }, now: 0 });

  const leaving = handoff.sample({
    bounds,
    cursor: { x: 920, y: 770 },
    now: 10,
  });
  assert.equal(leaving.held, true);
  assert.equal(leaving.releaseAt, 230);
  assert.equal(
    handoff.sample({ bounds, cursor: { x: 920, y: 770 }, now: 229 }).held,
    true,
  );
  const released = handoff.sample({
    bounds,
    cursor: { x: 920, y: 770 },
    now: 230,
  });
  assert.equal(released.held, false);
  assert.equal(released.changed, true);
});

test("re-entering the frame cancels a pending handoff release", () => {
  const handoff = new FramePointerHandoff({ leaveDelayMs: 220 });
  handoff.setFrameRect({ left: 10, top: 10, right: 200, bottom: 300 });
  const bounds = { x: 0, y: 0 };
  handoff.sample({ bounds, cursor: { x: 100, y: 100 }, now: 0 });
  handoff.sample({ bounds, cursor: { x: 400, y: 400 }, now: 20 });
  const returned = handoff.sample({
    bounds,
    cursor: { x: 150, y: 120 },
    now: 100,
  });
  assert.equal(returned.held, true);
  assert.equal(returned.releaseAt, null);
});

test("invalid or removed frame geometry releases the main-process lease", () => {
  const handoff = new FramePointerHandoff();
  assert.equal(handoff.setFrameRect({ left: 1, top: 2, right: 1, bottom: 3 }).held, false);
  handoff.setFrameRect({ left: 1, top: 2, right: 10, bottom: 30 });
  handoff.sample({ bounds: { x: 0, y: 0 }, cursor: { x: 5, y: 5 }, now: 0 });
  const cleared = handoff.setFrameRect(null);
  assert.equal(cleared.held, false);
  assert.equal(cleared.changed, true);
});

test("auto mode only accepts the pointer over the character", () => {
  assert.equal(shouldIgnoreMouseEvents({ mode: "auto", pointerOverCharacter: false }), true);
  assert.equal(shouldIgnoreMouseEvents({ mode: "auto", pointerOverCharacter: true }), false);
});

test("always mode keeps the window interactive everywhere", () => {
  assert.equal(shouldIgnoreMouseEvents({ mode: "always", pointerOverCharacter: false }), false);
  assert.equal(shouldIgnoreMouseEvents({ mode: "always", pointerOverCharacter: true }), false);
});

test("an active macOS frame gesture overrides automatic pass-through", () => {
  assert.equal(
    shouldIgnoreMouseEvents({ interactionActive: true, pointerOverCharacter: false }),
    false,
  );
  const controller = new WindowInteractionController();
  assert.equal(controller.resolve(), true);
  assert.equal(controller.setInteractionActive(true), false);
  assert.equal(controller.setPointerOverCharacter(false), null);
  assert.equal(controller.setInteractionActive(false), true);
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
