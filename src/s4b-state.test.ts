import { describe, expect, it } from 'vitest';
import {
  S4bMouthGate,
  s4bActivityForVoice,
  s4bSpeakingPlaybackRate,
} from './s4b-state';

const VOICE: VoiceState = {
  activity: 'speaking',
  microphoneMuted: false,
  outputMuted: false,
  phase: 'active',
};

describe('S4b state video timing', () => {
  it('opens immediately and closes only after the silence envelope', () => {
    const gate = new S4bMouthGate(0.02, 320);

    expect(gate.update({ level: 0.5, now: 100, speaking: true })).toEqual({
      active: true,
      closeAt: null,
      closeThreshold: 0.008,
      reason: 'open-threshold',
      transition: 'opened',
    });
    expect(gate.update({ level: 0, now: 120, speaking: true })).toEqual({
      active: true,
      closeAt: 440,
      closeThreshold: 0.008,
      reason: null,
      transition: null,
    });
    expect(gate.update({ level: 0, now: 439, speaking: true }).active).toBe(
      true,
    );
    expect(gate.update({ level: 0, now: 440, speaking: true })).toEqual({
      active: false,
      closeAt: null,
      closeThreshold: 0.008,
      reason: 'silence-envelope',
      transition: 'closed',
    });
  });

  it('cancels a pending close when speech resumes and resets outside speaking', () => {
    const gate = new S4bMouthGate(0.02, 320);
    gate.update({ level: 0.4, now: 0, speaking: true });
    gate.update({ level: 0, now: 10, speaking: true });

    expect(gate.update({ level: 0.3, now: 100, speaking: true })).toEqual({
      active: true,
      closeAt: null,
      closeThreshold: 0.008,
      reason: null,
      transition: null,
    });
    expect(gate.update({ level: 0.3, now: 101, speaking: false })).toEqual({
      active: false,
      closeAt: null,
      closeThreshold: 0.008,
      reason: 'voice-not-speaking',
      transition: 'closed',
    });
  });

  it('bridges 80–240 ms zero-level valleys without stopping the mouth', () => {
    const gate = new S4bMouthGate(0.02, 320);
    gate.update({ level: 0.4, now: 0, speaking: true });
    for (const [start, duration] of [
      [100, 80],
      [300, 160],
      [600, 240],
    ] as const) {
      expect(gate.update({ level: 0, now: start, speaking: true }).active).toBe(
        true,
      );
      expect(
        gate.update({ level: 0, now: start + duration, speaking: true }).active,
      ).toBe(true);
      expect(
        gate.update({ level: 0.25, now: start + duration, speaking: true })
          .active,
      ).toBe(true);
    }
  });

  it('keeps quiet speech above the lower close threshold active', () => {
    const gate = new S4bMouthGate(0.02, 320);
    gate.update({ level: 0.4, now: 0, speaking: true });
    expect(gate.update({ level: 0.01, now: 400, speaking: true })).toMatchObject({
      active: true,
      closeAt: null,
      closeThreshold: 0.008,
    });
  });

  it('maps inactive and muted voice states to idle video', () => {
    expect(s4bActivityForVoice(VOICE)).toBe('speaking');
    expect(s4bActivityForVoice({ ...VOICE, activity: 'thinking' })).toBe(
      'thinking',
    );
    expect(s4bActivityForVoice({ ...VOICE, phase: 'inactive' })).toBe('idle');
    expect(s4bActivityForVoice({ ...VOICE, outputMuted: true })).toBe('idle');
  });

  it('keeps the authored speaking-loop speed independent of level', () => {
    expect(s4bSpeakingPlaybackRate(1, 0)).toBe(1);
    expect(s4bSpeakingPlaybackRate(1, 1)).toBe(1);
    expect(s4bSpeakingPlaybackRate(0.8, Number.NaN)).toBe(0.8);
  });
});
