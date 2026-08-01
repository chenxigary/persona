/** Mirrors MIN/MAX_CHARACTER_SIZE in electron/settings-store.cjs. */
export const CHARACTER_SIZE = {
  max: 1.6,
  min: 0.7,
  step: 0.1,
} as const;

export function clampCharacterSize(size: number): number {
  if (!Number.isFinite(size)) return 1;
  return Math.min(CHARACTER_SIZE.max, Math.max(CHARACTER_SIZE.min, size));
}

/**
 * Next size one step from `size`. Rounded to whole steps so repeated presses
 * land on clean values rather than accumulating floating point drift, and
 * clamped so the buttons can be held down safely.
 */
export function nudgeCharacterSize(size: number, direction: 1 | -1): number {
  const current = clampCharacterSize(size);
  const steps = Math.round(current / CHARACTER_SIZE.step) + direction;
  return clampCharacterSize(
    Math.round(steps * CHARACTER_SIZE.step * 1000) / 1000,
  );
}

export function canGrow(size: number): boolean {
  return clampCharacterSize(size) < CHARACTER_SIZE.max - 1e-6;
}

export function canShrink(size: number): boolean {
  return clampCharacterSize(size) > CHARACTER_SIZE.min + 1e-6;
}

export function formatCharacterSize(size: number): string {
  return `${Math.round(clampCharacterSize(size) * 100)}%`;
}
