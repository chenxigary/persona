import { useCallback, useEffect, useRef } from 'react';
import { frameStyle } from '../character-frame';
import {
  canGrow,
  canShrink,
  dragRadius,
  formatCharacterSize,
  nudgeCharacterSize,
  sizeFromDrag,
} from '../character-size';
import type { ScreenRect } from '../pointer-region';

interface CharacterFrameProps {
  characterSize: number;
  /** Live size while a corner is being dragged; null commits the stored size. */
  onPreviewSize: (size: number | null) => void;
  rect: ScreenRect | null;
  visible: boolean;
}

const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;

export function CharacterFrame({
  characterSize,
  onPreviewSize,
  rect,
  visible,
}: CharacterFrameProps) {
  const box = frameStyle(rect);
  const scaling = useRef<{
    centre: { x: number; y: number };
    size: number;
    startRadius: number;
  } | null>(null);

  const handleSettings = useCallback(() => {
    window.personaBridge?.showSettings();
  }, []);

  const handleHide = useCallback(() => {
    window.personaBridge?.hide();
  }, []);

  const handleShrink = useCallback(() => {
    void window.personaSettings?.setCharacterSize(
      nudgeCharacterSize(characterSize, -1),
    );
  }, [characterSize]);

  const handleGrow = useCallback(() => {
    void window.personaSettings?.setCharacterSize(
      nudgeCharacterSize(characterSize, 1),
    );
  }, [characterSize]);

  const handleScaleStart = useCallback(
    (event: React.PointerEvent) => {
      if (!rect) return;
      event.preventDefault();
      event.stopPropagation();
      const centre = {
        x: (rect.left + rect.right) / 2,
        y: (rect.top + rect.bottom) / 2,
      };
      scaling.current = {
        centre,
        size: characterSize,
        startRadius: dragRadius(centre, { x: event.clientX, y: event.clientY }),
      };
      (event.target as Element).setPointerCapture?.(event.pointerId);
    },
    [characterSize, rect],
  );

  useEffect(() => {
    // Tracked on window rather than on the handle, so a drag that outruns the
    // pointer still ends cleanly.
    const handleMove = (event: PointerEvent) => {
      const origin = scaling.current;
      if (!origin) return;
      onPreviewSize(
        sizeFromDrag(
          origin.size,
          origin.startRadius,
          dragRadius(origin.centre, { x: event.clientX, y: event.clientY }),
        ),
      );
    };
    const handleUp = (event: PointerEvent) => {
      const origin = scaling.current;
      if (!origin) return;
      scaling.current = null;
      const size = sizeFromDrag(
        origin.size,
        origin.startRadius,
        dragRadius(origin.centre, { x: event.clientX, y: event.clientY }),
      );
      // Persist once at the end. setCharacterSize writes to disk, so calling it
      // for every pointermove would hammer it for the whole drag.
      onPreviewSize(null);
      void window.personaSettings?.setCharacterSize(size);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [onPreviewSize]);

  if (!box) return null;

  return (
    <div
      aria-hidden={!visible}
      className={`character-frame${visible ? ' is-visible' : ''}`}
      data-testid="character-frame"
      style={{
        height: `${box.height}px`,
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
      }}
    >
      <div className="character-frame__outline" />

      {/* The whole bar is an OS window-drag surface; the buttons opt back out. */}
      <div className="character-frame__bar">
        <div className="character-frame__actions character-frame__actions--size">
          <button
            className="character-frame__button"
            disabled={!canShrink(characterSize)}
            onClick={handleShrink}
            tabIndex={visible ? 0 : -1}
            title="缩小角色"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path d="M4 7.2h8a.8.8 0 0 1 0 1.6H4a.8.8 0 0 1 0-1.6Z" fill="currentColor" />
            </svg>
          </button>
          <span className="character-frame__size" title="角色大小">
            {formatCharacterSize(characterSize)}
          </span>
          <button
            className="character-frame__button"
            disabled={!canGrow(characterSize)}
            onClick={handleGrow}
            tabIndex={visible ? 0 : -1}
            title="放大角色"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path
                d="M7.2 4a.8.8 0 0 1 1.6 0v3.2H12a.8.8 0 0 1 0 1.6H8.8V12a.8.8 0 0 1-1.6 0V8.8H4a.8.8 0 0 1 0-1.6h3.2V4Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
        <span className="character-frame__grip" title="拖动移动角色" />
        <div className="character-frame__actions">
          <button
            className="character-frame__button"
            onClick={handleSettings}
            tabIndex={visible ? 0 : -1}
            title="打开设置"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path
                d="M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Zm5.5 2.4c0 .3 0 .6-.1.9l1.3 1a.3.3 0 0 1 .1.4l-1.2 2.1a.3.3 0 0 1-.4.1l-1.5-.6c-.4.3-.8.5-1.2.7l-.3 1.6a.3.3 0 0 1-.3.3H7.1a.3.3 0 0 1-.3-.3l-.3-1.6c-.4-.2-.8-.4-1.2-.7l-1.5.6a.3.3 0 0 1-.4-.1L2.2 10.3a.3.3 0 0 1 .1-.4l1.3-1a5.6 5.6 0 0 1 0-1.8l-1.3-1a.3.3 0 0 1-.1-.4l1.2-2.1a.3.3 0 0 1 .4-.1l1.5.6c.4-.3.8-.5 1.2-.7l.3-1.6a.3.3 0 0 1 .3-.3h2.4a.3.3 0 0 1 .3.3l.3 1.6c.4.2.8.4 1.2.7l1.5-.6a.3.3 0 0 1 .4.1l1.2 2.1a.3.3 0 0 1-.1.4l-1.3 1c.1.3.1.6.1.9Z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            className="character-frame__button"
            onClick={handleHide}
            tabIndex={visible ? 0 : -1}
            title="隐藏角色（托盘可重新显示）"
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16">
              <path
                d="M3.6 6.1a.8.8 0 0 1 1.1-.1L8 8.9l3.3-2.9a.8.8 0 1 1 1 1.2l-3.8 3.3a.8.8 0 0 1-1 0L3.7 7.2a.8.8 0 0 1-.1-1.1Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
      </div>

      {CORNERS.map((corner) => (
        <span
          className={`character-frame__corner character-frame__corner--${corner}`}
          key={corner}
          onPointerDown={handleScaleStart}
          title="拖动缩放角色"
        />
      ))}
    </div>
  );
}
