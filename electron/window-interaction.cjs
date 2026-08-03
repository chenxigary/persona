"use strict";

const INTERACTION_MODES = new Set(["auto", "always"]);
const DEFAULT_INTERACTION_MODE = "auto";
const DEFAULT_FRAME_POINTER_LEAVE_DELAY_MS = 220;

/**
 * The avatar overlay is a large transparent window pinned above every other
 * application. Without pass-through the whole rectangle swallows clicks meant
 * for the windows underneath, so buttons behind the transparent area cannot be
 * reached.
 *
 * In `auto` mode the window only accepts the pointer while it is actually over
 * the character; everywhere else the click falls through. `always` keeps the
 * window interactive, which is what you want while repositioning, orbiting or
 * zooming from empty space.
 */
function shouldIgnoreMouseEvents({
  interactionActive = false,
  mode = DEFAULT_INTERACTION_MODE,
  pointerOverCharacter = false,
} = {}) {
  if (interactionActive) return false;
  if (mode === "always") return false;
  return !pointerOverCharacter;
}

function normalizeInteractionMode(value) {
  return INTERACTION_MODES.has(value) ? value : DEFAULT_INTERACTION_MODE;
}

function normalizeFrameRect(value) {
  if (!value || typeof value !== "object") return null;
  const left = Number(value.left);
  const top = Number(value.top);
  const right = Number(value.right);
  const bottom = Number(value.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (right <= left || bottom <= top) return null;
  // Renderer coordinates are window-local CSS pixels. Keep a generous bound
  // so a compromised or broken renderer cannot pin an effectively infinite
  // interactive area in the main process.
  if ([left, top, right, bottom].some((coordinate) => Math.abs(coordinate) > 10_000)) {
    return null;
  }
  return { bottom, left, right, top };
}

function windowLocalPoint(cursor, bounds) {
  if (!cursor || !bounds) return null;
  const x = Number(cursor.x) - Number(bounds.x);
  const y = Number(cursor.y) - Number(bounds.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function pointInsideRect(point, rect) {
  return Boolean(
    point &&
      rect &&
      point.x >= rect.left &&
      point.x <= rect.right &&
      point.y >= rect.top &&
      point.y <= rect.bottom,
  );
}

/**
 * Owns the fragile handoff from forwarded renderer hover events to macOS
 * app-region chrome. Once the frame is visible, Electron's main process polls
 * the real screen cursor and keeps a short lease after it leaves. Chromium can
 * emit mouseout/blur while entering an app-region, but that no longer hides the
 * controls before the native drag has a chance to start.
 */
class FramePointerHandoff {
  constructor({ leaveDelayMs = DEFAULT_FRAME_POINTER_LEAVE_DELAY_MS } = {}) {
    this.leaveDelayMs = Math.max(0, Number(leaveDelayMs) || 0);
    this.frameRect = null;
    this.held = false;
    this.releaseAt = null;
  }

  setFrameRect(value) {
    this.frameRect = normalizeFrameRect(value);
    if (this.frameRect) {
      const changed = !this.held;
      // Renderer hover is the acquisition event. Main-process screen sampling
      // then owns release, so a synthetic Chromium mouseout cannot win the race
      // before the first 33 ms poll.
      this.held = true;
      if (changed) this.releaseAt = null;
      return this.snapshot(changed, null);
    }
    const changed = this.held;
    this.held = false;
    this.releaseAt = null;
    return this.snapshot(changed, null);
  }

  sample({ bounds, cursor, now = Date.now() } = {}) {
    const point = windowLocalPoint(cursor, bounds);
    const inside = pointInsideRect(point, this.frameRect);
    const previous = this.held;
    if (inside) {
      this.held = true;
      this.releaseAt = null;
    } else if (this.held) {
      if (this.releaseAt == null) this.releaseAt = now + this.leaveDelayMs;
      if (now >= this.releaseAt) {
        this.held = false;
        this.releaseAt = null;
      }
    }
    return this.snapshot(previous !== this.held, point, inside);
  }

  reset() {
    const changed = this.held;
    this.frameRect = null;
    this.held = false;
    this.releaseAt = null;
    return this.snapshot(changed, null);
  }

  snapshot(changed, point, inside = false) {
    return {
      changed,
      held: this.held,
      inside,
      point,
      releaseAt: this.releaseAt,
    };
  }
}

class WindowInteractionController {
  constructor({ mode = DEFAULT_INTERACTION_MODE } = {}) {
    this.mode = normalizeInteractionMode(mode);
    this.interactionActive = false;
    this.pointerOverCharacter = false;
    this.applied = null;
  }

  /** Returns the ignore flag when it changed, or null when nothing to do. */
  resolve() {
    const ignore = shouldIgnoreMouseEvents({
      mode: this.mode,
      interactionActive: this.interactionActive,
      pointerOverCharacter: this.pointerOverCharacter,
    });
    if (ignore === this.applied) return null;
    this.applied = ignore;
    return ignore;
  }

  setMode(mode) {
    this.mode = normalizeInteractionMode(mode);
    return this.resolve();
  }

  setPointerOverCharacter(over) {
    this.pointerOverCharacter = Boolean(over);
    return this.resolve();
  }

  setInteractionActive(active) {
    this.interactionActive = Boolean(active);
    return this.resolve();
  }

  /**
   * Forgets what was last pushed to the window. Call this when the window is
   * recreated or re-shown, because a fresh BrowserWindow starts interactive and
   * the cached value would suppress the corrective call.
   */
  reset() {
    this.interactionActive = false;
    this.pointerOverCharacter = false;
    this.applied = null;
  }
}

function applyInteractionToWindow(window, ignore) {
  if (ignore == null || !window || window.isDestroyed?.()) return false;
  window.setIgnoreMouseEvents(ignore, { forward: true });
  return true;
}

module.exports = {
  DEFAULT_FRAME_POINTER_LEAVE_DELAY_MS,
  DEFAULT_INTERACTION_MODE,
  FramePointerHandoff,
  INTERACTION_MODES,
  WindowInteractionController,
  applyInteractionToWindow,
  normalizeInteractionMode,
  normalizeFrameRect,
  pointInsideRect,
  shouldIgnoreMouseEvents,
  windowLocalPoint,
};
