"use strict";

const INTERACTION_MODES = new Set(["auto", "always"]);
const DEFAULT_INTERACTION_MODE = "auto";

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
  mode = DEFAULT_INTERACTION_MODE,
  pointerOverCharacter = false,
} = {}) {
  if (mode === "always") return false;
  return !pointerOverCharacter;
}

function normalizeInteractionMode(value) {
  return INTERACTION_MODES.has(value) ? value : DEFAULT_INTERACTION_MODE;
}

class WindowInteractionController {
  constructor({ mode = DEFAULT_INTERACTION_MODE } = {}) {
    this.mode = normalizeInteractionMode(mode);
    this.pointerOverCharacter = false;
    this.applied = null;
  }

  /** Returns the ignore flag when it changed, or null when nothing to do. */
  resolve() {
    const ignore = shouldIgnoreMouseEvents({
      mode: this.mode,
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

  /**
   * Forgets what was last pushed to the window. Call this when the window is
   * recreated or re-shown, because a fresh BrowserWindow starts interactive and
   * the cached value would suppress the corrective call.
   */
  reset() {
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
  DEFAULT_INTERACTION_MODE,
  INTERACTION_MODES,
  WindowInteractionController,
  applyInteractionToWindow,
  normalizeInteractionMode,
  shouldIgnoreMouseEvents,
};
