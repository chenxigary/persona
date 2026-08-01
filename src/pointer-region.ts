export interface ScreenRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface NdcPoint {
  x: number;
  y: number;
}

export interface ViewportSize {
  height: number;
  width: number;
}

/**
 * Converts projected normalised device coordinates into a CSS-pixel rectangle
 * that covers every supplied point, expanded by `padding` and clamped to the
 * viewport. Returns null when there is nothing to cover.
 *
 * The renderer uses this to describe where the character actually is on screen
 * so the transparent remainder of the overlay window can stay click-through.
 */
export function screenRectFromNdc(
  points: readonly NdcPoint[],
  size: ViewportSize,
  padding = 0,
): ScreenRect | null {
  if (points.length === 0 || size.width <= 0 || size.height <= 0) return null;

  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const x = ((point.x + 1) / 2) * size.width;
    const y = ((1 - point.y) / 2) * size.height;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }

  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;

  return {
    left: Math.max(0, left - padding),
    top: Math.max(0, top - padding),
    right: Math.min(size.width, right + padding),
    bottom: Math.min(size.height, bottom + padding),
  };
}

/** Inclusive hit test against a screen rectangle. A null rect never matches. */
export function isPointerInsideRect(
  x: number,
  y: number,
  rect: ScreenRect | null,
): boolean {
  if (!rect) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
