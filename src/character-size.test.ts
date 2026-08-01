import { describe, expect, it } from 'vitest';
import {
  canGrow,
  canShrink,
  CHARACTER_SIZE,
  clampCharacterSize,
  formatCharacterSize,
  nudgeCharacterSize,
} from './character-size';

describe('clampCharacterSize', () => {
  it('keeps a size inside the range the settings store accepts', () => {
    expect(clampCharacterSize(1)).toBe(1);
    expect(clampCharacterSize(0.1)).toBe(CHARACTER_SIZE.min);
    expect(clampCharacterSize(9)).toBe(CHARACTER_SIZE.max);
  });

  it('falls back to the default rather than passing a broken value on', () => {
    expect(clampCharacterSize(Number.NaN)).toBe(1);
  });
});

describe('nudgeCharacterSize', () => {
  it('moves one step in either direction', () => {
    expect(nudgeCharacterSize(1, 1)).toBeCloseTo(1.1, 6);
    expect(nudgeCharacterSize(1, -1)).toBeCloseTo(0.9, 6);
  });

  it('stops at the bounds so a held button cannot run past them', () => {
    expect(nudgeCharacterSize(CHARACTER_SIZE.max, 1)).toBe(CHARACTER_SIZE.max);
    expect(nudgeCharacterSize(CHARACTER_SIZE.min, -1)).toBe(CHARACTER_SIZE.min);
  });

  it('lands on clean steps instead of drifting', () => {
    // Repeated float addition would leave values like 1.2000000000000002,
    // which then show as odd percentages.
    let size: number = CHARACTER_SIZE.min;
    for (let press = 0; press < 9; press += 1) {
      size = nudgeCharacterSize(size, 1);
      expect(Number.isInteger(Math.round(size * 1000) - size * 1000)).toBe(true);
      expect(size * 10).toBeCloseTo(Math.round(size * 10), 6);
    }
    expect(size).toBe(CHARACTER_SIZE.max);
  });

  it('snaps an off-step size onto the grid', () => {
    expect(nudgeCharacterSize(1.04, 1)).toBeCloseTo(1.1, 6);
    expect(nudgeCharacterSize(1.04, -1)).toBeCloseTo(0.9, 6);
  });

  it('round trips up and back down', () => {
    expect(nudgeCharacterSize(nudgeCharacterSize(1.2, 1), -1)).toBeCloseTo(1.2, 6);
  });
});

describe('canGrow and canShrink', () => {
  it('disable the button that would do nothing', () => {
    expect(canGrow(CHARACTER_SIZE.max)).toBe(false);
    expect(canShrink(CHARACTER_SIZE.min)).toBe(false);
    expect(canGrow(1)).toBe(true);
    expect(canShrink(1)).toBe(true);
  });

  it('is not fooled by floating point noise at the bounds', () => {
    expect(canGrow(CHARACTER_SIZE.max - 1e-9)).toBe(false);
    expect(canShrink(CHARACTER_SIZE.min + 1e-9)).toBe(false);
  });
});

describe('formatCharacterSize', () => {
  it('shows a whole percentage', () => {
    expect(formatCharacterSize(1)).toBe('100%');
    expect(formatCharacterSize(0.7)).toBe('70%');
    expect(formatCharacterSize(1.6)).toBe('160%');
  });

  it('never shows a value outside the range', () => {
    expect(formatCharacterSize(5)).toBe('160%');
  });
});
