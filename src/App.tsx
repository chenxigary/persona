import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { CharacterFrame } from './components/CharacterFrame';
import { Scene } from './components/Scene';
import { RealisticAvatar } from './components/RealisticAvatar';
import { S4bAvatar } from './components/S4bAvatar';
import {
  INITIAL_AVATAR_SURFACE_STATE,
  reduceAvatarSurface,
  shouldShowRealisticAvatar,
} from './avatar-surface';
import { resolveFrameState } from './character-frame';
import type { ScreenRect } from './pointer-region';
import {
  animationUrlsForType,
  immediateVoiceAnimation,
  type AnimationType,
} from './animation-catalog';
import {
  finishBodyAnimationOverride,
  resolveBodyAnimation,
  type BodyAnimationOverride,
} from './animation-priority';
import {
  loadPackagedSettingsFallback,
  SETTINGS_FALLBACK,
} from './settings-defaults';

const INITIAL_STATE: VoiceState = {
  activity: 'idle',
  microphoneMuted: false,
  outputMuted: false,
  phase: 'inactive',
};

const BODY_IDLE_DELAY_MS = 650;

export function App() {
  const [voice, setVoice] = useState<VoiceState>(INITIAL_STATE);
  const [audioLevel, setAudioLevel] = useState(0);
  const [voiceAnimation, setVoiceAnimation] = useState<AnimationType>('IDLE');
  const [bodyOverride, setBodyOverride] =
    useState<BodyAnimationOverride | null>(null);
  const [settings, setSettings] =
    useState<PersonaSettingsSnapshot>(SETTINGS_FALLBACK);
  const [characterRect, setCharacterRect] = useState<ScreenRect | null>(null);
  const [frameVisible, setFrameVisible] = useState(false);
  const [frameRect, setFrameRect] = useState<ScreenRect | null>(null);
  const [avatarSurface, dispatchAvatarSurface] = useReducer(
    reduceAvatarSurface,
    INITIAL_AVATAR_SURFACE_STATE,
  );
  const [s4bPack, setS4bPack] = useState<S4bAvatarPack | null>(null);
  const [s4bPhase, setS4bPhase] =
    useState<AvatarDriverRuntimePhase>('off');
  const [s4bReady, setS4bReady] = useState(false);
  const [s4bRenderFailed, setS4bRenderFailed] = useState(false);
  // Held only while a frame corner is being dragged, so the character rescales
  // live without writing to disk on every pointer move.
  const [previewSize, setPreviewSize] = useState<number | null>(null);
  const characterRectRef = useRef<ScreenRect | null>(null);
  const frameInteractionActive = useRef(false);
  const frameInteractionSources = useRef({
    adjustment: false,
    gesture: false,
    mainPointerHold: false,
    windowMoving: false,
  });
  const frameVisibleRef = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const reportedCapture = useRef<boolean | null>(null);
  const reportedFrameGeometry = useRef<string | null>(null);

  useEffect(() => {
    const bridge = window.personaBridge;
    if (!bridge) return;
    const handleEvent = (event: AvatarBridgeEvent) => {
      if (event.type === 'state') setVoice(event.state);
      else if (event.type === 'audio-level') {
        setAudioLevel(event.level);
      } else if (event.type === 'animation') {
        if (event.requestId != null) {
          setBodyOverride({
            animation: event.animation,
            animationName: event.animationName,
            animationUrls: event.animationUrls,
            requestId: event.requestId,
          });
        } else if (event.animation !== 'CUSTOM') {
          setVoiceAnimation(event.animation);
        }
      } else if (event.type === 'avatar-driver-status') {
        if (event.status.driverId === 's4b') {
          setS4bPhase(event.status.phase);
          if (event.status.phase !== 'ready') setS4bReady(false);
          if (event.status.phase === 'failed') setS4bRenderFailed(true);
          return;
        }
        dispatchAvatarSurface({ phase: event.status.phase, type: 'status' });
      } else if (event?.type === 'avatar-frame') {
        dispatchAvatarSurface({ phase: 'ready', type: 'status' });
        dispatchAvatarSurface({ frame: event, type: 'frame' });
      } else if (event.type === 'avatar-state-pack') {
        setS4bPack(event.pack);
        setS4bReady(false);
        setS4bRenderFailed(false);
      }
    };
    void bridge.getSnapshot().then((snapshot) => {
      for (const event of Array.isArray(snapshot)
        ? snapshot
        : snapshot == null
          ? []
          : [snapshot]) {
        handleEvent(event);
      }
    });
    return bridge.subscribe(handleEvent);
  }, []);

  useEffect(() => {
    const settingsBridge = window.personaSettings;
    if (!settingsBridge) {
      void loadPackagedSettingsFallback().then(setSettings);
      return;
    }
    void settingsBridge.get().then(setSettings);
    return settingsBridge.subscribe(setSettings);
  }, []);

  const speaking =
    voice.phase === 'active' &&
    voice.activity === 'speaking' &&
    !voice.outputMuted;

  useEffect(() => {
    const immediateAnimation = immediateVoiceAnimation(voice);
    if (immediateAnimation != null) {
      setVoiceAnimation(immediateAnimation);
      if (immediateAnimation === 'IDLE') setAudioLevel(0);
      return;
    }

    const timer = window.setTimeout(
      () => setVoiceAnimation('IDLE'),
      BODY_IDLE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [voice]);

  const animation = resolveBodyAnimation(voiceAnimation, bodyOverride);
  const defaultModel =
    settings.default_model_id == null
      ? undefined
      : settings.models.find(
          (model) => model.id === settings.default_model_id,
        );
  const animationRequest = bodyOverride?.requestId ?? 0;
  const configuredAnimationUrls = useMemo(
    () => animationUrlsForType(settings.animations, animation),
    [animation, settings.animations],
  );
  const animationUrls =
    bodyOverride?.animationUrls ?? configuredAnimationUrls;
  const overrideRequestId = bodyOverride?.requestId ?? null;
  const showRealisticAvatar = shouldShowRealisticAvatar(avatarSurface);
  const showS4bAvatar =
    s4bPack != null &&
    s4bPhase === 'ready' &&
    s4bReady &&
    !s4bRenderFailed;
  const handleAnimationComplete = useCallback(() => {
    if (overrideRequestId == null) return;
    setBodyOverride((current) =>
      finishBodyAnimationOverride(current, overrideRequestId),
    );
  }, [overrideRequestId]);
  const handleRealisticFrameLoaded = useCallback((sequence: number) => {
    dispatchAvatarSurface({ sequence, type: 'loaded' });
  }, []);
  const handleS4bReady = useCallback(() => {
    setS4bReady(true);
    setS4bRenderFailed(false);
  }, []);
  const handleS4bError = useCallback(() => {
    setS4bReady(false);
    setS4bRenderFailed(true);
  }, []);
  const handleS4bCharacterRect = useCallback(
    (rect: ScreenRect | null) => {
      if (showS4bAvatar) setCharacterRect(rect);
    },
    [showS4bAvatar],
  );

  const applyFrameState = useCallback(() => {
    const state = resolveFrameState({
      characterRect: characterRectRef.current,
      interactionActive: frameInteractionActive.current,
      pointer: pointer.current,
      viewport: { height: window.innerHeight, width: window.innerWidth },
      wasVisible: frameVisibleRef.current,
    });
    frameVisibleRef.current = state.visible;
    setFrameVisible(state.visible);
    setFrameRect(state.frameRect);
    const geometry = { frameRect: state.frameRect, visible: state.visible };
    const geometryKey = JSON.stringify(geometry);
    if (reportedFrameGeometry.current !== geometryKey) {
      reportedFrameGeometry.current = geometryKey;
      window.personaBridge?.setFramePointerGeometry?.(geometry);
    }
    if (reportedCapture.current === state.capturePointer) return;
    reportedCapture.current = state.capturePointer;
    window.personaBridge?.setPointerRegion(state.capturePointer);
  }, []);

  const setFrameInteractionSource = useCallback(
    (
      source: 'adjustment' | 'gesture' | 'mainPointerHold' | 'windowMoving',
      active: boolean,
    ) => {
      frameInteractionSources.current[source] = active;
      frameInteractionActive.current = Object.values(
        frameInteractionSources.current,
      ).some(Boolean);
      applyFrameState();
    },
    [applyFrameState],
  );

  const setFrameGestureActive = useCallback(
    (active: boolean) => setFrameInteractionSource('gesture', active),
    [setFrameInteractionSource],
  );

  // The projected character rectangle refreshes several times per second as
  // animation moves the model. Keep it outside the pointer-listener effect so
  // those updates cannot reset the frame's hover hysteresis while the pointer
  // is travelling from the character to a toolbar button.
  useEffect(() => {
    characterRectRef.current = characterRect;
    applyFrameState();
  }, [applyFrameState, characterRect]);

  // The frame is drawn around the character, so its buttons sit outside the
  // character's own rectangle. The window therefore has to accept the pointer
  // across the whole framed area while the frame is up, or those buttons land
  // in the click-through region and cannot be clicked at all.
  useEffect(() => {

    const handleMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      applyFrameState();
    };
    const forgetPointer = (force = false) => {
      if (frameInteractionActive.current) return;
      // Once Electron knows the visible frame rectangle, the main process owns
      // the person-to-app-region handoff with the real screen cursor. Chromium
      // may emit mouseout/blur merely because the pointer entered a native drag
      // region; treating that as a true exit is the bug that made the chrome
      // vanish before pointerdown.
      if (
        !force &&
        frameVisibleRef.current &&
        window.personaBridge?.onFramePointerHold
      ) {
        return;
      }
      if (pointer.current == null) return;
      pointer.current = null;
      applyFrameState();
    };
    // mouseleave on window is unreliable in Chromium, and once the pointer is
    // off the window there are no more moves to correct a stale position - the
    // frame would simply stay up forever. mouseout with a null relatedTarget is
    // the event that actually fires when the pointer exits the document.
    const handleOut = (event: MouseEvent) => {
      if (event.relatedTarget == null) forgetPointer();
    };

    window.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseout', handleOut);
    const handleLeave = () => forgetPointer();
    document.addEventListener('mouseleave', handleLeave);
    // Losing focus means the pointer is almost certainly somewhere else, and
    // pass-through windows do not always get a final move on the way out.
    const handleBlur = () => forgetPointer();
    window.addEventListener('blur', handleBlur);
    window.addEventListener('resize', applyFrameState);
    applyFrameState();
    return () => {
      window.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseout', handleOut);
      document.removeEventListener('mouseleave', handleLeave);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('resize', applyFrameState);
      window.personaBridge?.setPointerRegion(false);
      window.personaBridge?.setFramePointerGeometry?.({
        frameRect: null,
        visible: false,
      });
      frameVisibleRef.current = false;
      reportedCapture.current = null;
      reportedFrameGeometry.current = null;
    };
  }, [applyFrameState]);

  useEffect(() => {
    const bridge = window.personaBridge;
    if (!bridge) return;
    const stopMoving = bridge.onWindowMoving?.((active) =>
      setFrameInteractionSource('windowMoving', active),
    );
    const stopPointerHold = bridge.onFramePointerHold?.((active) => {
      if (!active) pointer.current = null;
      setFrameInteractionSource('mainPointerHold', active);
    });
    const stopAdjustment = bridge.onFrameAdjustmentMode?.((active) =>
      setFrameInteractionSource('adjustment', active),
    );
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') bridge.setFrameAdjustmentMode?.(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      stopMoving?.();
      stopPointerHold?.();
      stopAdjustment?.();
      window.removeEventListener('keydown', handleKeyDown);
      frameInteractionSources.current = {
        adjustment: false,
        gesture: false,
        mainPointerHold: false,
        windowMoving: false,
      };
      frameInteractionActive.current = false;
    };
  }, [setFrameInteractionSource]);

  return defaultModel ? (
    <main className="app">
      {!showRealisticAvatar && !showS4bAvatar && (
        <Scene
          animation={animation}
          animationRequest={animationRequest}
          animationUrls={animationUrls}
          audioLevel={audioLevel}
          characterSize={previewSize ?? settings.character_size}
          lighting={settings.model_lighting[defaultModel.id]}
          modelUrl={defaultModel.asset_url}
          onAnimationComplete={handleAnimationComplete}
          onCharacterRect={setCharacterRect}
          playback={bodyOverride ? 'once' : 'loop'}
          speaking={speaking}
        />
      )}
      {avatarSurface.frame && (
        <RealisticAvatar
          active={showRealisticAvatar}
          characterSize={previewSize ?? settings.character_size}
          frame={avatarSurface.frame}
          onCharacterRect={setCharacterRect}
          onFrameLoaded={handleRealisticFrameLoaded}
        />
      )}
      {s4bPack && (
        <S4bAvatar
          active={showS4bAvatar}
          audioLevel={audioLevel}
          characterSize={previewSize ?? settings.character_size}
          onCharacterRect={handleS4bCharacterRect}
          onError={handleS4bError}
          onReady={handleS4bReady}
          pack={s4bPack}
          voice={voice}
        />
      )}
      <CharacterFrame
        characterSize={previewSize ?? settings.character_size}
        onInteractionChange={setFrameGestureActive}
        onPreviewSize={setPreviewSize}
        rect={frameRect}
        visible={frameVisible}
      />
    </main>
  ) : (
    <main className="app" />
  );
}
