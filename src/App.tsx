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
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const reportedRegion = useRef<string | null>(null);

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
      const viewport = { height: window.innerHeight, width: window.innerWidth };
      const state = resolveFrameState({
        characterRect,
        pointer: pointer.current,
        viewport,
        wasVisible: visible,
      });
      visible = state.visible;
      setFrameVisible(state.visible);
      setFrameRect(state.frameRect);

      const key = state.pointerRegion
        ? `${state.pointerRegion.left},${state.pointerRegion.top},${state.pointerRegion.right},${state.pointerRegion.bottom}`
        : null;
      const over = state.pointerRegion != null;
      if (reportedRegion.current === (over ? key : null)) return;
      reportedRegion.current = over ? key : null;
      window.personaBridge?.setPointerRegion(over);
    };

    const handleMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      apply();
    };
    const handleLeave = () => {
      pointer.current = null;
      apply();
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseleave', handleLeave);
    window.addEventListener('resize', apply);
    apply();
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseleave', handleLeave);
      window.removeEventListener('resize', apply);
      window.personaBridge?.setPointerRegion(false);
      reportedRegion.current = null;
    };
  }, [characterRect]);

  return defaultModel ? (
    <main className="app">
      <Scene
        animation={animation}
        animationRequest={animationRequest}
        animationUrls={animationUrls}
        audioLevel={audioLevel}
        characterSize={settings.character_size}
        lighting={settings.model_lighting[defaultModel.id]}
        modelUrl={defaultModel.asset_url}
        onAnimationComplete={handleAnimationComplete}
        onCharacterRect={setCharacterRect}
        playback={bodyOverride ? 'once' : 'loop'}
        speaking={speaking}
      />
      <CharacterFrame rect={frameRect} visible={frameVisible} />
    </main>
  ) : (
    <main className="app" />
  );
}
