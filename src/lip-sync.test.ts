import { describe, expect, it } from 'vitest';
import {
  advanceVisemePhase,
  LIP_SYNC,
  smoothMouthLevel,
  targetMouthLevel,
  VISEMES,
  visemeWeights,
} from './lip-sync';

describe('targetMouthLevel', () => {
  it('closes the mouth when not speaking', () => {
    expect(targetMouthLevel(0.9, false)).toBe(0);
  });

  it('closes the mouth below the silence threshold', () => {
    expect(targetMouthLevel(LIP_SYNC.silenceThreshold, true)).toBe(0);
    expect(targetMouthLevel(LIP_SYNC.silenceThreshold + 0.001, true)).toBeGreaterThan(0);
  });

  it('scales the quiet output level up and clamps at one', () => {
    expect(targetMouthLevel(0.2, true)).toBeCloseTo(0.2 * LIP_SYNC.levelGain, 6);
    expect(targetMouthLevel(0.95, true)).toBe(1);
  });

  it('treats a broken level as silence rather than a wide open mouth', () => {
    expect(targetMouthLevel(Number.NaN, true)).toBe(0);
  });
});

describe('smoothMouthLevel', () => {
  it('opens faster than it closes', () => {
    const opened = smoothMouthLevel(0, 1, 0.016);
    const closed = 1 - smoothMouthLevel(1, 0, 0.016);
    expect(opened).toBeGreaterThan(closed);
  });

  it('converges toward the target without overshooting', () => {
    let level = 0;
    for (let step = 0; step < 60; step += 1) level = smoothMouthLevel(level, 1, 0.016);
    expect(level).toBeGreaterThan(0.99);
    expect(level).toBeLessThanOrEqual(1);
  });

  it('holds still for a zero or broken frame time', () => {
    expect(smoothMouthLevel(0.4, 1, 0)).toBe(0.4);
    expect(smoothMouthLevel(0.4, 1, Number.NaN)).toBe(0.4);
  });
});

describe('advanceVisemePhase', () => {
  it('cycles near the rate of human syllables rather than well above it', () => {
    // One second of silence-level speech, then one second at full volume.
    const quiet = advanceVisemePhase(0, 0, 1);
    const loud = advanceVisemePhase(0, 1, 1);
    expect(quiet).toBeCloseTo(LIP_SYNC.visemeRateBase, 6);
    expect(loud).toBeCloseTo(
      LIP_SYNC.visemeRateBase + LIP_SYNC.visemeRateGain,
      6,
    );
    // Speech runs roughly four to seven syllables per second. Staying inside
    // ten keeps the mouth from reading as chatter.
    expect(loud).toBeLessThanOrEqual(10);
    expect(quiet).toBeGreaterThanOrEqual(3);
  });

  it('moves faster when louder', () => {
    expect(advanceVisemePhase(0, 1, 0.1)).toBeGreaterThan(
      advanceVisemePhase(0, 0.1, 0.1),
    );
  });

  it('holds still for a zero or broken frame time', () => {
    expect(advanceVisemePhase(3.5, 1, 0)).toBe(3.5);
    expect(advanceVisemePhase(3.5, 1, Number.NaN)).toBe(3.5);
  });
});

describe('visemeWeights', () => {
  it('returns one weight per viseme', () => {
    expect(visemeWeights(1.2, 0.5)).toHaveLength(VISEMES.length);
  });

  it('never exceeds the maximum or goes negative', () => {
    for (const phase of [0, 0.4, 1.9, 7.3, 21.6]) {
      for (const weight of visemeWeights(phase, 1)) {
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(LIP_SYNC.maxWeight);
      }
    }
  });

  it('closes every viseme at zero level', () => {
    expect(visemeWeights(2.4, 0)).toEqual(VISEMES.map(() => 0));
  });

  it('peaks on the active viseme and falls off around it', () => {
    // Phase 0 makes the first viseme active, so weights must decrease along it.
    const weights = visemeWeights(0, 1);
    expect(weights[0]).toBeGreaterThan(weights[1]);
    expect(weights[1]).toBeGreaterThan(weights[2]);
    expect(weights.at(-1)).toBe(0);
  });

  it('moves the peak as the phase advances', () => {
    expect(visemeWeights(0, 1)[0]).toBeGreaterThan(visemeWeights(2, 1)[0]);
    expect(visemeWeights(2, 1)[2]).toBeGreaterThan(visemeWeights(0, 1)[2]);
  });

  it('keeps the shimmer subtle rather than making the mouth flap', () => {
    // Stay inside one viseme window (phase 0 to 1) so the only thing varying is
    // the flutter. Sampling across a boundary would measure the shape falloff
    // instead, which is supposed to be large.
    const samples = [];
    for (let step = 0; step < 20; step += 1) {
      samples.push(visemeWeights(step * 0.048, 1)[0]);
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(max - min).toBeLessThan(max * 0.35);
  });
});
