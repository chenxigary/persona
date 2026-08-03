export interface RealisticAvatarFrame {
  height: number;
  sequence: number;
  sid: string;
  url: string;
  width: number;
}

export type RealisticAvatarPhase =
  | 'off'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'stopped';

export interface AvatarSurfaceState {
  frame: RealisticAvatarFrame | null;
  loadedSequence: number;
  phase: RealisticAvatarPhase;
}

export const INITIAL_AVATAR_SURFACE_STATE: AvatarSurfaceState = {
  frame: null,
  loadedSequence: 0,
  phase: 'off',
};

export type AvatarSurfaceAction =
  | { type: 'status'; phase: RealisticAvatarPhase }
  | { type: 'frame'; frame: RealisticAvatarFrame }
  | { type: 'loaded'; sequence: number };

export function reduceAvatarSurface(
  state: AvatarSurfaceState,
  action: AvatarSurfaceAction,
): AvatarSurfaceState {
  if (action.type === 'status') {
    if (action.phase === state.phase) return state;
    if (action.phase !== 'ready') {
      return { frame: null, loadedSequence: 0, phase: action.phase };
    }
    return { ...state, phase: action.phase };
  }
  if (action.type === 'frame') {
    if (action.frame.sequence <= (state.frame?.sequence ?? 0)) return state;
    return { ...state, frame: action.frame };
  }
  if (
    state.frame == null ||
    action.sequence > state.frame.sequence ||
    action.sequence <= state.loadedSequence
  ) {
    return state;
  }
  return { ...state, loadedSequence: action.sequence };
}

export type FrameBufferIndex = 0 | 1;

export interface RealisticFrameBufferState {
  frames: [RealisticAvatarFrame | null, RealisticAvatarFrame | null];
  front: FrameBufferIndex;
  latest: RealisticAvatarFrame | null;
  loading: FrameBufferIndex | null;
}

export const INITIAL_REALISTIC_FRAME_BUFFER: RealisticFrameBufferState = {
  frames: [null, null],
  front: 0,
  latest: null,
  loading: null,
};

export type RealisticFrameBufferAction =
  | { type: 'receive'; frame: RealisticAvatarFrame }
  | { type: 'loaded'; index: FrameBufferIndex };

function backOf(index: FrameBufferIndex): FrameBufferIndex {
  return index === 0 ? 1 : 0;
}

export function reduceRealisticFrameBuffer(
  state: RealisticFrameBufferState,
  action: RealisticFrameBufferAction,
): RealisticFrameBufferState {
  if (action.type === 'receive') {
    if (action.frame.sequence <= (state.latest?.sequence ?? 0)) return state;
    if (state.loading != null) return { ...state, latest: action.frame };
    const loading = backOf(state.front);
    const frames = [...state.frames] as RealisticFrameBufferState['frames'];
    frames[loading] = action.frame;
    return { ...state, frames, latest: action.frame, loading };
  }

  if (action.index !== state.loading) return state;
  const loaded = state.frames[action.index];
  if (!loaded) return state;
  if (state.latest && state.latest.sequence > loaded.sequence) {
    const loading = backOf(action.index);
    const frames = [...state.frames] as RealisticFrameBufferState['frames'];
    frames[loading] = state.latest;
    return { ...state, frames, front: action.index, loading };
  }
  return { ...state, front: action.index, loading: null };
}

export function shouldShowRealisticAvatar(state: AvatarSurfaceState): boolean {
  return state.phase === 'ready' && state.loadedSequence > 0;
}
