import { describe, expect, it } from 'vitest';
import { shouldUseProceduralMotion } from './useProceduralMotion';

describe('procedural motion fallback', () => {
  it('runs when the current action has no VRMA clips', () => {
    expect(shouldUseProceduralMotion()).toBe(true);
    expect(shouldUseProceduralMotion([])).toBe(true);
  });

  it('yields to a configured VRMA clip', () => {
    expect(shouldUseProceduralMotion(['idle.vrma'])).toBe(false);
  });
});
