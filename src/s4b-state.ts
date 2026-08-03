export interface S4bMouthGateSnapshot {
  active: boolean;
  closeAt: number | null;
  closeThreshold: number;
  reason: S4bMouthTransitionReason | null;
  transition: 'closed' | 'opened' | null;
}

export type S4bMouthTransitionReason =
  | 'open-threshold'
  | 'silence-envelope'
  | 'voice-not-speaking';

interface S4bMouthGateInput {
  level: number;
  now: number;
  speaking: boolean;
}

export class S4bMouthGate {
  private active = false;
  private closeAt: number | null = null;
  private readonly closeThreshold: number;

  constructor(
    private readonly openThreshold: number,
    private readonly closeDelayMs: number,
    closeThreshold = Math.min(openThreshold * 0.45, 0.008),
  ) {
    this.closeThreshold = Math.max(
      0,
      Math.min(openThreshold, Number.isFinite(closeThreshold) ? closeThreshold : 0),
    );
  }

  update({ level, now, speaking }: S4bMouthGateInput): S4bMouthGateSnapshot {
    if (!speaking) {
      const transition = this.active ? 'closed' : null;
      this.active = false;
      this.closeAt = null;
      return this.snapshot(
        transition,
        transition ? 'voice-not-speaking' : null,
      );
    }

    const normalizedLevel = Number.isFinite(level)
      ? Math.max(0, Math.min(1, level))
      : 0;
    if (normalizedLevel > this.openThreshold) {
      const transition = this.active ? null : 'opened';
      this.active = true;
      this.closeAt = null;
      return this.snapshot(transition, transition ? 'open-threshold' : null);
    }

    if (!this.active) return this.snapshot();
    // Hysteresis: once open, quiet speech only needs to clear the lower close
    // threshold to refresh the peak-hold envelope. This prevents soft syllables
    // from repeatedly pausing the authored speaking loop.
    if (normalizedLevel > this.closeThreshold) {
      this.closeAt = null;
      return this.snapshot();
    }
    if (this.closeAt == null) this.closeAt = now + this.closeDelayMs;
    if (now >= this.closeAt) {
      this.active = false;
      this.closeAt = null;
      return this.snapshot('closed', 'silence-envelope');
    }
    return this.snapshot();
  }

  reset(): S4bMouthGateSnapshot {
    this.active = false;
    this.closeAt = null;
    return this.snapshot();
  }

  private snapshot(
    transition: 'closed' | 'opened' | null = null,
    reason: S4bMouthTransitionReason | null = null,
  ): S4bMouthGateSnapshot {
    return {
      active: this.active,
      closeAt: this.closeAt,
      closeThreshold: this.closeThreshold,
      reason,
      transition,
    };
  }
}

export function s4bActivityForVoice(voice: VoiceState): VoiceActivity {
  if (
    voice.phase === 'inactive' ||
    voice.phase === 'stopping' ||
    voice.outputMuted
  ) {
    return 'idle';
  }
  return voice.activity;
}

export function s4bSpeakingPlaybackRate(
  baseRate: number,
  audioLevel: number,
): number {
  // Audio amplitude decides whether the authored loop plays, never how fast it
  // plays. Modulating a generic pre-rendered mouth clip made energetic speech
  // look unnaturally accelerated and could not improve phoneme alignment.
  void audioLevel;
  const normalized = Number.isFinite(baseRate) ? baseRate : 1;
  return Math.max(0.25, Math.min(4, normalized));
}
