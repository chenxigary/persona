export const VISEMES = ['aa', 'ee', 'ih', 'oh', 'ou'] as const;

export type Viseme = (typeof VISEMES)[number];

/**
 * Amplitude-driven mouth shapes. There is no phoneme recognition here: the
 * visemes simply cycle and the measured output level scales how far the mouth
 * opens. "Correct" is therefore a matter of how it reads, and a mouth that
 * changes shape many times a second reads as chattering rather than speaking.
 *
 * Every value below is a tuning knob. Rate first if the mouth feels wrong.
 */
export const LIP_SYNC = {
  /** Below this the mouth is closed regardless of the speaking flag. */
  silenceThreshold: 0.008,
  /** Output level is quiet, so scale it up before driving the mouth. */
  levelGain: 2.8,
  /** Opening is quicker than closing, which is how speech actually looks. */
  attackSeconds: 0.055,
  releaseSeconds: 0.13,
  /**
   * Shapes per second when barely audible, and the extra rate at full volume.
   * Human speech runs about 4 to 7 syllables per second, so the range sits
   * just around that rather than well above it.
   */
  visemeRateBase: 4.5,
  visemeRateGain: 4.5,
  /** Small shimmer over the cycle, as a multiple of the viseme rate. */
  flutterRate: 2.4,
  flutterDepth: 0.18,
  /** How sharply neighbouring visemes fall off from the active one. */
  shapeFalloff: 0.72,
  /** Fully open would look like a yawn on most models. */
  maxWeight: 0.62,
} as const;

export function targetMouthLevel(level: number, speaking: boolean): number {
  if (!speaking || !Number.isFinite(level) || level <= LIP_SYNC.silenceThreshold) {
    return 0;
  }
  return Math.min(1, Math.max(0, level) * LIP_SYNC.levelGain);
}

/**
 * Exponential follower. Returns the new smoothed level, moving toward `target`
 * at the attack rate when opening and the slower release rate when closing.
 */
export function smoothMouthLevel(
  current: number,
  target: number,
  delta: number,
): number {
  if (!Number.isFinite(delta) || delta <= 0) return current;
  const tau =
    target > current ? LIP_SYNC.attackSeconds : LIP_SYNC.releaseSeconds;
  const factor = 1 - Math.exp(-delta / tau);
  return current + (target - current) * factor;
}

export function advanceVisemePhase(
  phase: number,
  level: number,
  delta: number,
): number {
  if (!Number.isFinite(delta) || delta <= 0) return phase;
  const rate =
    LIP_SYNC.visemeRateBase + Math.max(0, level) * LIP_SYNC.visemeRateGain;
  return phase + delta * rate;
}

/** Weight for every viseme at this instant, in VISEMES order. */
export function visemeWeights(phase: number, level: number): number[] {
  const active = Math.floor(phase) % VISEMES.length;
  return VISEMES.map((_, index) => {
    const shape = Math.max(0, 1 - Math.abs(index - active) * LIP_SYNC.shapeFalloff);
    const flutter =
      1 -
      LIP_SYNC.flutterDepth +
      Math.sin(phase * LIP_SYNC.flutterRate + index) * LIP_SYNC.flutterDepth;
    return Math.min(LIP_SYNC.maxWeight, Math.max(0, level * shape * flutter));
  });
}
