import { describe, expect, it } from 'vitest';
import {
  isPointerInsideRect,
  screenRectFromNdc,
  type ScreenRect,
} from './pointer-region';

const size = { width: 400, height: 600 };

describe('screenRectFromNdc', () => {
  it('maps normalised device coordinates onto CSS pixels', () => {
    // NDC origin is the viewport centre and +y points up, so it must land at
    // half the height rather than at the top.
    expect(screenRectFromNdc([{ x: 0, y: 0 }], size)).toEqual({
      left: 200,
      right: 200,
      top: 300,
      bottom: 300,
    });
  });

  it('covers every supplied corner', () => {
    const rect = screenRectFromNdc(
      [
        { x: -0.5, y: 0.5 },
        { x: 0.5, y: -0.5 },
        { x: 0, y: 0 },
      ],
      size,
    );
    expect(rect).toEqual({ left: 100, right: 300, top: 150, bottom: 450 });
  });

  it('expands by the padding and clamps to the viewport', () => {
    const rect = screenRectFromNdc([{ x: -1, y: 1 }, { x: 1, y: -1 }], size, 20);
    expect(rect).toEqual({ left: 0, right: 400, top: 0, bottom: 600 });
  });

  it('ignores non-finite projections instead of poisoning the bounds', () => {
    const rect = screenRectFromNdc(
      [{ x: Number.NaN, y: 0 }, { x: 0, y: 0 }],
      size,
    );
    expect(rect).toEqual({ left: 200, right: 200, top: 300, bottom: 300 });
  });

  it('returns null when there is nothing usable to cover', () => {
    expect(screenRectFromNdc([], size)).toBeNull();
    expect(screenRectFromNdc([{ x: Number.NaN, y: Number.NaN }], size)).toBeNull();
    expect(screenRectFromNdc([{ x: 0, y: 0 }], { width: 0, height: 600 })).toBeNull();
  });
});

describe('isPointerInsideRect', () => {
  const rect: ScreenRect = { left: 100, right: 300, top: 150, bottom: 450 };

  it('accepts interior points and the border', () => {
    expect(isPointerInsideRect(200, 300, rect)).toBe(true);
    expect(isPointerInsideRect(100, 150, rect)).toBe(true);
    expect(isPointerInsideRect(300, 450, rect)).toBe(true);
  });

  it('rejects points outside on every side', () => {
    expect(isPointerInsideRect(99, 300, rect)).toBe(false);
    expect(isPointerInsideRect(301, 300, rect)).toBe(false);
    expect(isPointerInsideRect(200, 149, rect)).toBe(false);
    expect(isPointerInsideRect(200, 451, rect)).toBe(false);
  });

  it('never matches without a rect, so an unloaded character stays click-through', () => {
    expect(isPointerInsideRect(200, 300, null)).toBe(false);
  });
});
