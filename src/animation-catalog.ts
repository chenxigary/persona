export type AnimationType =
  | 'IDLE'
  | 'THINKING'
  | 'GREETING'
  | 'TALK'
  | 'HAPPY'
  | 'FINGER_GUN'
  | 'DANCE';
export type PlayableAnimationType = AnimationType | 'CUSTOM';

export function immediateVoiceAnimation(
  voice: Pick<VoiceState, 'activity' | 'outputMuted' | 'phase'>,
): 'IDLE' | 'THINKING' | 'TALK' | null {
  if (voice.phase !== 'active') return 'IDLE';
  if (voice.activity === 'thinking') return 'THINKING';
  if (voice.outputMuted) return 'IDLE';
  if (voice.activity === 'speaking') return 'TALK';
  return null;
}

export function animationUrlsForType(
  animations: readonly PersonaAnimationSettings[],
  type: PlayableAnimationType,
): string[] {
  return animations
    .filter((animation) => animation.animation_type === type)
    .flatMap((animation) => animation.asset_urls);
}

export function randomAnimationUrl(
  choices: readonly string[],
  previous: string | null = null,
  random: () => number = Math.random,
): string | null {
  if (choices.length === 0) return null;
  const candidates =
    choices.length > 1 && previous != null
      ? choices.filter((choice) => choice !== previous)
      : choices;
  const randomIndex = Math.min(
    candidates.length - 1,
    Math.floor(Math.max(0, random()) * candidates.length),
  );
  return candidates[randomIndex] ?? null;
}
