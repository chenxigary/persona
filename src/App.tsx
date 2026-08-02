import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CharacterFrame } from './components/CharacterFrame';
import { Scene } from './components/Scene';
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
  // Held only while a frame corner is being dragged, so the character rescales
  // live without writing to disk on every pointer move.
  const [previewSize, setPreviewSize] = useState<number | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const reportedCapture = useRef<boolean | null>(null);

  useEffect(() => {
    const bridge = window.personaBridge;
    if (!bridge) return;
    void bridge.getSnapshot().then((event) => {
      if (event?.type === 'state') setVoice(event.state);
    });
    return bridge.subscribe((event) => {
      if (event.type === 'state') {
        setVoice(event.state);
      } else if (event.type === 'audio-level') {
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
      }
    });
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
  const handleAnimationComplete = useCallback(() => {
    if (overrideRequestId == null) return;
    setBodyOverride((current) =>
      finishBodyAnimationOverride(current, overrideRequestId),
    );
  }, [overrideRequestId]);

  // The frame is drawn around the character, so its buttons sit outside the
  // character's own rectangle. The window therefore has to accept the pointer
  // across the whole framed area while the frame is up, or those buttons land
  // in the click-through region and cannot be clicked at all.
  useEffect(() => {
    let visible = false;

    const apply = () => {
      const state = resolveFrameState({
        characterRect,
        pointer: pointer.current,
        viewport: { height: window.innerHeight, width: window.innerWidth },
        wasVisible: visible,
      });
      visible = state.visible;
      setFrameVisible(state.visible);
      setFrameRect(state.frameRect);
      if (reportedCapture.current === state.capturePointer) return;
      reportedCapture.current = state.capturePointer;
      window.personaBridge?.setPointerRegion(state.capturePointer);
    };

    const handleMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      apply();
    };
    const forgetPointer = () => {
      if (pointer.current == null) return;
      pointer.current = null;
      apply();
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
    document.addEventListener('mouseleave', forgetPointer);
    // Losing focus means the pointer is almost certainly somewhere else, and
    // pass-through windows do not always get a final move on the way out.
    window.addEventListener('blur', forgetPointer);
    window.addEventListener('resize', apply);
    apply();
    return () => {
      window.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseout', handleOut);
      document.removeEventListener('mouseleave', forgetPointer);
      window.removeEventListener('blur', forgetPointer);
      window.removeEventListener('resize', apply);
      window.personaBridge?.setPointerRegion(false);
      reportedCapture.current = null;
    };
  }, [characterRect]);

  return defaultModel ? (
    <main className="app">
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
      <CharacterFrame
        characterSize={previewSize ?? settings.character_size}
        onPreviewSize={setPreviewSize}
        rect={frameRect}
        visible={frameVisible}
      />
    </main>
  ) : (
    <main className="app" />
  );
}
