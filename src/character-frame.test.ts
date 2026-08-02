import { describe, expect, it } from 'vitest';
import {
  expandRectForChrome,
  FRAME_CHROME,
  frameStyle,
  resolveFrameState,
} from './character-frame';
import type { ScreenRect } from './pointer-region';

const viewport = { width: 430, height: 680 };
const characterRect: ScreenRect = {
  left: 150,
  right: 280,
  top: 200,
  bottom: 560,
};

describe('expandRectForChrome', () => {
  it('reserves more room above for the toolbar', () => {
    expect(expandRectForChrome(characterRect, viewport)).toEqual({
      left: 150 - FRAME_CHROME.left,
      right: 280 + FRAME_CHROME.right,
      top: 200 - FRAME_CHROME.top,
      bottom: 560 + FRAME_CHROME.bottom,
    });
  });

  it('clamps to the window so the toolbar stays reachable', () => {
    const edge: ScreenRect = { left: 2, right: 428, top: 4, bottom: 678 };
    expect(expandRectForChrome(edge, viewport)).toEqual({
      left: 0,
      right: 430,
      top: 0,
      bottom: 680,
    });
  });

  it('passes through a missing rect', () => {
    expect(expandRectForChrome(null, viewport)).toBeNull();
  });
});

describe('resolveFrameState', () => {
  const inCharacter = { x: 200, y: 300 };
  // Inside the toolbar strip above the character: outside the character rect,
  // inside the framed rect.
  const onToolbar = { x: 200, y: 200 - FRAME_CHROME.top + 8 };
  const wellOutside = { x: 400, y: 640 };

  it('shows the frame once the pointer reaches the character', () => {
    const state = resolveFrameState({
      characterRect,
      pointer: inCharacter,
      viewport,
    });
    expect(state.visible).toBe(true);
    expect(state.capturePointer).toBe(true);
  });

  it('stays hidden when the pointer is only over the chrome margin', () => {
    // Without this the frame would pop up from empty space next to the model.
    const state = resolveFrameState({
      characterRect,
      pointer: onToolbar,
      viewport,
    });
    expect(state.visible).toBe(false);
    expect(state.capturePointer).toBe(false);
  });

  it('keeps the frame while the pointer moves onto the toolbar', () => {
    // The whole point of the hysteresis: reaching a button means leaving the
    // character, and the button must not vanish on the way.
    const state = resolveFrameState({
      characterRect,
      pointer: onToolbar,
      viewport,
      wasVisible: true,
    });
    expect(state.visible).toBe(true);
    expect(state.capturePointer).toBe(true);
  });

  it('keeps toolbar hysteresis when animation refreshes the character rect', () => {
    const entered = resolveFrameState({
      characterRect,
      pointer: inCharacter,
      viewport,
    });
    const refreshedCharacterRect = {
      ...characterRect,
      left: characterRect.left + 1,
      right: characterRect.right + 1,
    };
    const refreshed = resolveFrameState({
      characterRect: refreshedCharacterRect,
      pointer: onToolbar,
      viewport,
      wasVisible: entered.visible,
    });

    expect(refreshed.visible).toBe(true);
    expect(refreshed.capturePointer).toBe(true);
  });

  it('releases the pointer as soon as it leaves the framed area', () => {
    // Reporting a region here regardless of where the pointer actually is was
    // enough to keep the window swallowing every click underneath it.
    const state = resolveFrameState({
      characterRect,
      pointer: wellOutside,
      viewport,
      wasVisible: true,
    });
    expect(state.visible).toBe(false);
    expect(state.capturePointer).toBe(false);
  });

  it('claims nothing while the pointer is off the window', () => {
    const state = resolveFrameState({
      characterRect,
      pointer: null,
      viewport,
      wasVisible: true,
    });
    expect(state.visible).toBe(false);
    expect(state.capturePointer).toBe(false);
  });

  it('claims nothing before the character has loaded', () => {
    const state = resolveFrameState({
      characterRect: null,
      pointer: inCharacter,
      viewport,
      wasVisible: true,
    });
    expect(state.visible).toBe(false);
    expect(state.capturePointer).toBe(false);
    expect(state.frameRect).toBeNull();
  });
});

describe('frameStyle', () => {
  it('converts a rect into a positioned box', () => {
    expect(frameStyle({ left: 10, top: 20, right: 110, bottom: 220 })).toEqual({
      left: 10,
      top: 20,
      width: 100,
      height: 200,
    });
  });

  it('never reports a negative size', () => {
    expect(frameStyle({ left: 100, top: 100, right: 40, bottom: 40 })).toEqual({
      left: 100,
      top: 100,
      width: 0,
      height: 0,
    });
  });

  it('passes through a missing rect', () => {
    expect(frameStyle(null)).toBeNull();
  });
});
