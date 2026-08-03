import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ScreenRect } from '../pointer-region';
import {
  S4bMouthGate,
  s4bActivityForVoice,
  s4bSpeakingPlaybackRate,
  type S4bMouthTransitionReason,
} from '../s4b-state';

interface S4bAvatarProps {
  active: boolean;
  audioLevel: number;
  characterSize: number;
  onCharacterRect: (rect: ScreenRect | null) => void;
  onError: (message: string) => void;
  onReady: () => void;
  pack: S4bAvatarPack;
  voice: VoiceState;
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

function clipStartSeconds(clip: S4bStateClip): number {
  return clip.startOffsetMs / 1000;
}

/**
 * The sample pack's raw state loops and its LiteAvatar-generated speech loop
 * do not share identical framing. Swapping those full-frame sources makes the
 * character visibly jump as soon as speech begins. Keep one decoded speaking
 * surface mounted for the whole session instead: its authored neutral frame is
 * the idle/listening/thinking surface, and audio only starts or pauses that
 * same video underneath the neutral canvas.
 */
export function S4bAvatar({
  active,
  audioLevel,
  characterSize,
  onCharacterRect,
  onError,
  onReady,
  pack,
  voice,
}: S4bAvatarProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const speakingVideoRef = useRef<HTMLVideoElement | null>(null);
  const closedFrameRef = useRef<HTMLCanvasElement | null>(null);
  const readyReported = useRef(false);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const [mouthActive, setMouthActive] = useState(false);
  const [mouthTransitionReason, setMouthTransitionReason] =
    useState<S4bMouthTransitionReason | null>(null);
  const [closedFrameReady, setClosedFrameReady] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const pendingMouthTransition = useRef<{
    active: boolean;
    level: number;
    reason: S4bMouthTransitionReason;
  } | null>(null);
  const desiredActivity = s4bActivityForVoice(voice);
  const mouthGate = useMemo(
    () =>
      new S4bMouthGate(
        pack.mouthGate.openThreshold,
        pack.mouthGate.closeDelayMs,
      ),
    [pack.mouthGate.closeDelayMs, pack.mouthGate.openThreshold],
  );

  useEffect(() => {
    readyReported.current = false;
    setSurfaceReady(false);
    setMouthActive(false);
    setMouthTransitionReason(null);
    setClosedFrameReady(false);
    pendingMouthTransition.current = null;
    mouthGate.reset();
  }, [mouthGate, pack.clips.speaking.url, pack.id]);

  const captureClosedFrame = useCallback(
    (video: HTMLVideoElement) => {
      const draw = () => {
        const canvas = closedFrameRef.current;
        if (
          !canvas ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          video.videoWidth <= 0 ||
          video.videoHeight <= 0
        ) {
          return;
        }
        const context = canvas.getContext('2d');
        if (!context) {
          onError('Unable to create the S4b neutral frame.');
          return;
        }
        try {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          setClosedFrameReady(true);
          setSurfaceReady(true);
          if (!readyReported.current) {
            readyReported.current = true;
            onReady();
          }
        } catch {
          setClosedFrameReady(false);
          onError('Unable to decode the S4b neutral frame.');
        }
      };
      // `loadeddata` already guarantees a current decoded frame. Chromium does
      // not promise requestVideoFrameCallback for a video that stays paused, so
      // waiting for it here can strand the renderer on its VRM fallback.
      const drawNextFrame = () => window.requestAnimationFrame(draw);
      const start = clipStartSeconds(pack.clips.speaking);
      video.pause();
      if (
        Number.isFinite(video.duration) &&
        start < video.duration &&
        Math.abs(video.currentTime - start) > 0.04
      ) {
        video.addEventListener('seeked', drawNextFrame, { once: true });
        video.currentTime = start;
        return;
      }
      drawNextFrame();
    },
    [onError, onReady, pack.clips.speaking],
  );

  useEffect(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const speaking = desiredActivity === 'speaking';
    const now = performance.now();
    const next = mouthGate.update({ level: audioLevel, now, speaking });
    if (next.transition && next.reason) {
      pendingMouthTransition.current = {
        active: next.active,
        level: audioLevel,
        reason: next.reason,
      };
      setMouthTransitionReason(next.reason);
    }
    setMouthActive(next.active);
    if (next.closeAt == null) return;

    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      const closed = mouthGate.update({
        level: 0,
        now: performance.now(),
        speaking: true,
      });
      if (closed.transition && closed.reason) {
        pendingMouthTransition.current = {
          active: closed.active,
          level: 0,
          reason: closed.reason,
        };
        setMouthTransitionReason(closed.reason);
      }
      setMouthActive(closed.active);
    }, Math.max(0, next.closeAt - now));
    return () => {
      if (closeTimer.current != null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
  }, [audioLevel, desiredActivity, mouthGate]);

  useEffect(() => {
    const video = speakingVideoRef.current;
    if (!video) return;
    const transition = pendingMouthTransition.current;
    pendingMouthTransition.current = null;
    const reportTransition = () => {
      if (!transition) return;
      window.personaBridge?.reportS4bMouthTransition?.({
        active: transition.active,
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
        level: transition.level,
        paused: video.paused,
        reason: transition.reason,
        voiceActivity: desiredActivity,
      });
    };
    if (mouthActive) {
      video.playbackRate = s4bSpeakingPlaybackRate(
        pack.clips.speaking.playbackRate,
        0,
      );
      void video.play().then(reportTransition, reportTransition);
      return;
    }
    video.pause();
    reportTransition();
  }, [desiredActivity, mouthActive, pack.clips.speaking.playbackRate]);

  const reportRect = useCallback(() => {
    const stage = stageRef.current;
    onCharacterRect(active && surfaceReady && stage ? visibleRect(stage) : null);
  }, [active, onCharacterRect, surfaceReady]);

  useLayoutEffect(() => {
    reportRect();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(reportRect);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [characterSize, pack.height, pack.width, reportRect]);

  useEffect(() => {
    window.addEventListener('resize', reportRect);
    return () => {
      window.removeEventListener('resize', reportRect);
      onCharacterRect(null);
    };
  }, [onCharacterRect, reportRect]);

  const speakingClip = pack.clips.speaking;
  return (
    <div
      aria-hidden={!active}
      className={`s4b-avatar${active ? ' is-active' : ''}`}
      data-active-state={desiredActivity}
      data-closed-frame-ready={closedFrameReady ? 'true' : 'false'}
      data-mouth-active={mouthActive ? 'true' : 'false'}
      data-mouth-transition-reason={mouthTransitionReason ?? ''}
      data-ready={surfaceReady ? 'true' : 'false'}
      data-surface-mode="single"
      data-testid="s4b-avatar"
      style={
        {
          '--character-scale': characterSize,
          '--s4b-cross-fade-ms': `${pack.crossFadeMs}ms`,
        } as React.CSSProperties
      }
    >
      <div
        className="s4b-avatar__stage"
        data-testid="s4b-stage"
        ref={stageRef}
        style={{ aspectRatio: `${pack.width} / ${pack.height}` }}
      >
        <div className="s4b-avatar__motion">
          <video
            aria-hidden="true"
            className="s4b-avatar__video is-visible"
            data-state="speaking"
            data-testid="s4b-video-speaking"
            disablePictureInPicture
            draggable={false}
            height={pack.height}
            key={`${pack.id}:${speakingClip.url}`}
            loop
            muted
            onError={() => onError('Unable to decode the S4b speaking clip.')}
            onLoadedData={(event) => captureClosedFrame(event.currentTarget)}
            playsInline
            preload="auto"
            ref={speakingVideoRef}
            src={speakingClip.url}
            width={pack.width}
          />
          <canvas
            aria-hidden="true"
            className={`s4b-avatar__closed-frame${
              closedFrameReady && !mouthActive ? ' is-visible' : ''
            }`}
            data-testid="s4b-speaking-closed-frame"
            height={pack.height}
            ref={closedFrameRef}
            width={pack.width}
          />
        </div>
      </div>
    </div>
  );
}
