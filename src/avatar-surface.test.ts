import { describe, expect, it } from 'vitest';
import {
  INITIAL_AVATAR_SURFACE_STATE,
  INITIAL_REALISTIC_FRAME_BUFFER,
  reduceAvatarSurface,
  reduceRealisticFrameBuffer,
  shouldShowRealisticAvatar,
  type RealisticAvatarFrame,
} from './avatar-surface';

const FRAME: RealisticAvatarFrame = {
  height: 960,
  sequence: 1,
  sid: '',
  url: 'persona-avatar://frame/1',
  width: 448,
};

describe('realistic avatar surface', () => {
  it('keeps the VRM fallback until a ready frame has loaded', () => {
    const starting = reduceAvatarSurface(INITIAL_AVATAR_SURFACE_STATE, {
      phase: 'starting',
      type: 'status',
    });
    const ready = reduceAvatarSurface(starting, {
      phase: 'ready',
      type: 'status',
    });
    const received = reduceAvatarSurface(ready, { frame: FRAME, type: 'frame' });

    expect(shouldShowRealisticAvatar(received)).toBe(false);
    expect(
      shouldShowRealisticAvatar(
        reduceAvatarSurface(received, { sequence: 1, type: 'loaded' }),
      ),
    ).toBe(true);
  });

  it('ignores stale frames but accepts any decoded frame from the current run', () => {
    const current = {
      frame: { ...FRAME, sequence: 3, url: 'persona-avatar://frame/3' },
      loadedSequence: 2,
      phase: 'ready' as const,
    };

    expect(
      reduceAvatarSurface(current, { frame: FRAME, type: 'frame' }),
    ).toBe(current);
    expect(
      reduceAvatarSurface(current, { sequence: 2, type: 'loaded' })
        .loadedSequence,
    ).toBe(2);
  });

  it('double-buffers frames without replacing the visible image mid-load', () => {
    const frame2 = { ...FRAME, sequence: 2, url: 'persona-avatar://frame/2' };
    const frame3 = { ...FRAME, sequence: 3, url: 'persona-avatar://frame/3' };
    const loading1 = reduceRealisticFrameBuffer(
      INITIAL_REALISTIC_FRAME_BUFFER,
      { frame: FRAME, type: 'receive' },
    );
    expect(loading1.loading).toBe(1);
    expect(loading1.front).toBe(0);

    const queued2 = reduceRealisticFrameBuffer(loading1, {
      frame: frame2,
      type: 'receive',
    });
    expect(queued2.frames[1]).toBe(FRAME);
    expect(queued2.latest).toBe(frame2);

    const loading2 = reduceRealisticFrameBuffer(queued2, {
      index: 1,
      type: 'loaded',
    });
    expect(loading2.front).toBe(1);
    expect(loading2.loading).toBe(0);
    expect(loading2.frames[0]).toBe(frame2);

    const queued3 = reduceRealisticFrameBuffer(loading2, {
      frame: frame3,
      type: 'receive',
    });
    expect(queued3.frames[0]).toBe(frame2);
    expect(queued3.latest).toBe(frame3);
  });

  it('falls back immediately when the worker restarts or fails', () => {
    const active = {
      frame: FRAME,
      loadedSequence: 1,
      phase: 'ready' as const,
    };
    for (const phase of ['starting', 'failed', 'stopped'] as const) {
      const next = reduceAvatarSurface(active, { phase, type: 'status' });
      expect(shouldShowRealisticAvatar(next)).toBe(false);
      expect(next.frame).toBeNull();
      expect(next.loadedSequence).toBe(0);
    }
  });
});
