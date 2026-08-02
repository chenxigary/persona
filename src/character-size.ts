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

/** Distance from the frame centre to the pointer, used as the drag radius. */
export function dragRadius(
  centre: { x: number; y: number },
  point: { x: number; y: number },
): number {
  return Math.hypot(point.x - centre.x, point.y - centre.y);
}

/**
 * Size after dragging a frame corner. The frame is drawn around the character,
 * so pulling a corner away from the centre grows the character and pushing it
 * inward shrinks it, in proportion to how far the pointer moved relative to
 * where the drag started.
 *
 * Continuous rather than stepped: this is direct manipulation, and snapping
 * would fight the pointer. The stepped buttons remain for exact values.
 */
export function sizeFromDrag(
  startSize: number,
  startRadius: number,
  currentRadius: number,
): number {
  if (!Number.isFinite(startRadius) || startRadius <= 1) {
    return clampCharacterSize(startSize);
  }
  if (!Number.isFinite(currentRadius) || currentRadius < 0) {
    return clampCharacterSize(startSize);
  }
  return clampCharacterSize(startSize * (currentRadius / startRadius));
}
