import { isPointerInsideRect, type ScreenRect } from './pointer-region';

/**
 * Space reserved around the character for the frame outline and its toolbar.
 * The toolbar sits above the character, so the top edge needs more room.
 */
export const FRAME_CHROME = {
  bottom: 14,
  left: 14,
  right: 14,
  top: 44,
} as const;

export function expandRectForChrome(
  rect: ScreenRect | null,
  viewport: { height: number; width: number },
): ScreenRect | null {
  if (!rect) return null;
  return {
    left: Math.max(0, rect.left - FRAME_CHROME.left),
    top: Math.max(0, rect.top - FRAME_CHROME.top),
    right: Math.min(viewport.width, rect.right + FRAME_CHROME.right),
    bottom: Math.min(viewport.height, rect.bottom + FRAME_CHROME.bottom),
  };
}

/**
 * Decides whether the frame should be showing, and which rectangle the window
 * must accept the pointer inside.
 *
 * The frame is drawn around the character, so its buttons sit outside the
 * character's own rectangle. Without hysteresis the pointer would leave the
 * character on its way to a button, the frame would hide, and the button would
 * become unclickable. So: entering the character shows the frame, and the frame
 * only hides once the pointer leaves the larger framed rectangle.
 */
export function resolveFrameState({
  characterRect,
  pointer,
  viewport,
  wasVisible = false,
}: {
  characterRect: ScreenRect | null;
  pointer: { x: number; y: number } | null;
  viewport: { height: number; width: number };
  wasVisible?: boolean;
}): { capturePointer: boolean; frameRect: ScreenRect | null; visible: boolean } {
  const framedRect = expandRectForChrome(characterRect, viewport);
  if (!characterRect || !framedRect || !pointer) {
    return { capturePointer: false, frameRect: framedRect, visible: false };
  }

  const visible = wasVisible
    ? isPointerInsideRect(pointer.x, pointer.y, framedRect)
    : isPointerInsideRect(pointer.x, pointer.y, characterRect);

  return {
    frameRect: framedRect,
    // The window takes the pointer exactly while the frame is up. That covers
    // the character itself and the surrounding chrome, and releases the moment
    // the pointer leaves - anything else strands the window holding clicks that
    // belong to whatever is underneath.
    capturePointer: visible,
    visible,
  };
}

/** CSS box for the frame overlay, in pixels from the top-left of the window. */
export function frameStyle(rect: ScreenRect | null) {
  if (!rect) return null;
  return {
    height: Math.max(0, rect.bottom - rect.top),
    left: rect.left,
    top: rect.top,
    width: Math.max(0, rect.right - rect.left),
  };
}
