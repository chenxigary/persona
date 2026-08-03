import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from 'react';
import {
  INITIAL_REALISTIC_FRAME_BUFFER,
  reduceRealisticFrameBuffer,
  type FrameBufferIndex,
  type RealisticAvatarFrame,
} from '../avatar-surface';
import type { ScreenRect } from '../pointer-region';

interface RealisticAvatarProps {
  active: boolean;
  characterSize: number;
  frame: RealisticAvatarFrame;
  onCharacterRect: (rect: ScreenRect | null) => void;
  onFrameLoaded: (sequence: number) => void;
}

function visibleRect(element: HTMLElement): ScreenRect | null {
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) return null;
  return { bottom, left, right, top };
}

export function RealisticAvatar({
  active,
  characterSize,
  frame,
  onCharacterRect,
  onFrameLoaded,
}: RealisticAvatarProps) {
  const [buffer, dispatchBuffer] = useReducer(
    reduceRealisticFrameBuffer,
    INITIAL_REALISTIC_FRAME_BUFFER,
  );
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    dispatchBuffer({ frame, type: 'receive' });
  }, [frame]);

  const reportRect = useCallback(() => {
    const output = canvas.current;
    onCharacterRect(active && output ? visibleRect(output) : null);
  }, [active, onCharacterRect]);

  useLayoutEffect(() => {
    reportRect();
    const target = canvas.current;
    if (!target || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportRect);
    observer.observe(target);
    return () => observer.disconnect();
  }, [characterSize, frame.height, frame.width, reportRect]);

  useEffect(() => {
    window.addEventListener('resize', reportRect);
    return () => {
      window.removeEventListener('resize', reportRect);
      onCharacterRect(null);
    };
  }, [onCharacterRect, reportRect]);

  return (
    <div
      aria-hidden={!active}
      className={`realistic-avatar${active ? ' is-active' : ''}`}
      data-testid="realistic-avatar"
    >
      <canvas
        data-frame-sequence={buffer.frames[buffer.front]?.sequence ?? 0}
        data-source={buffer.frames[buffer.front]?.url ?? ''}
        data-testid="realistic-avatar-canvas"
        height={frame.height}
        ref={canvas}
        style={{ '--character-scale': characterSize } as React.CSSProperties}
        width={frame.width}
      />
      {([0, 1] as const).map((index: FrameBufferIndex) => {
        const bufferedFrame = buffer.frames[index];
        if (!bufferedFrame) return null;
        return (
          <img
            alt=""
            className="realistic-avatar__decoder"
            decoding="async"
            draggable={false}
            height={bufferedFrame.height}
            key={index}
            onLoad={(event) => {
              if (
                buffer.loading !== index ||
                buffer.frames[index]?.sequence !== bufferedFrame.sequence
              ) {
                return;
              }
              const output = canvas.current;
              if (!output) return;
              if (
                output.width !== bufferedFrame.width ||
                output.height !== bufferedFrame.height
              ) {
                output.width = bufferedFrame.width;
                output.height = bufferedFrame.height;
              }
              const context = output.getContext('2d');
              if (!context) return;
              context.drawImage(
                event.currentTarget,
                0,
                0,
                bufferedFrame.width,
                bufferedFrame.height,
              );
              onFrameLoaded(bufferedFrame.sequence);
              dispatchBuffer({ index, type: 'loaded' });
              if (active) window.requestAnimationFrame(reportRect);
            }}
            src={bufferedFrame.url}
            width={bufferedFrame.width}
          />
        );
      })}
    </div>
  );
}
