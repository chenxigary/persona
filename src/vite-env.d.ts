/// <reference types="vite/client" />

type VoicePhase = 'inactive' | 'starting' | 'active' | 'stopping';
type VoiceActivity = 'idle' | 'listening' | 'thinking' | 'speaking';

interface VoiceState {
  activity: VoiceActivity;
  locator?: { conversationId?: string; hostId?: string } | null;
  microphoneMuted: boolean;
  outputMuted: boolean;
  phase: VoicePhase;
  preferredPresentationSurface?: string | null;
  sessionId?: string | null;
}

interface AudioListenerStatus {
  available: boolean;
  capturing: boolean;
  error?: string;
  monitoring: boolean;
  source: string | null;
}

type AvatarDriverRuntimePhase =
  | 'off'
  | 'starting'
  | 'ready'
  | 'failed'
  | 'stopped';

interface AvatarDriverRuntimeStatusBase {
  driverId?: 'liteavatar' | 's4b';
  error: string | null;
  phase: AvatarDriverRuntimePhase;
}

interface LiteAvatarDriverRuntimeStatus extends AvatarDriverRuntimeStatusBase {
  audioDroppedBeforeReady: number;
  audioDroppedOutsideSpeech: number;
  audioInputBytes: number;
  audioSentBytes: number;
  avatarName: string;
  device: string;
  fps: number | null;
  frameSequence: number;
  frames: number;
  height: number;
  invalidMessages: number;
  loadSeconds: number | null;
  processId: number | null;
  restartCount: number;
  rssMb: number | null;
  runtimeAvailable: boolean;
  sampleRate: number;
  speechFrames: number;
  staleFrames: number;
  swapDeltaMb: number | null;
  systemFreeMb: number | null;
  width: number;
}

interface S4bDriverRuntimeStatus extends AvatarDriverRuntimeStatusBase {
  clipCount: number;
  driverId: 's4b';
  loadMs: number | null;
  packId: string | null;
  packName: string | null;
  runtimeAvailable: boolean;
  surface: 's4b';
}

type AvatarDriverRuntimeStatus =
  | LiteAvatarDriverRuntimeStatus
  | S4bDriverRuntimeStatus;

interface S4bStateClip {
  activity: VoiceActivity;
  playbackRate: number;
  startOffsetMs: number;
  url: string;
}

interface S4bAvatarPack {
  background: 'alpha' | 'opaque';
  clips: Record<VoiceActivity, S4bStateClip>;
  crossFadeMs: number;
  height: number;
  id: string;
  mouthGate: {
    closeDelayMs: number;
    openThreshold: number;
  };
  name: string;
  width: number;
}

interface PersonaLightingSettings {
  tone_mapping: 'none' | 'aces';
  exposure: number;
  environment_enabled: boolean;
  environment_intensity: number;
  key_light_intensity: number;
  ambient_intensity: number;
}

type PersonaAnimationType =
  | 'IDLE'
  | 'THINKING'
  | 'GREETING'
  | 'TALK'
  | 'HAPPY'
  | 'FINGER_GUN'
  | 'DANCE';

interface PersonaModelSettings {
  id: string;
  model_name: string;
  origin: 'packaged' | 'user';
  removable: boolean;
  asset_url: string;
}

interface PersonaAnimationSettings {
  id: string;
  animation_name: string;
  animation_description: string;
  animation_trigger_scenario: string;
  animation_type: PersonaAnimationType | null;
  origin: 'packaged' | 'user';
  system: boolean;
  editable: boolean;
  modified: boolean;
  removable: boolean;
  clips: PersonaAnimationClipSettings[];
  asset_urls: string[];
}

interface PersonaAnimationClipSettings {
  id: string;
  animation_name: string;
  origin: 'packaged' | 'user';
  removable: boolean;
  asset_url: string;
}

interface PersonaVoiceSourceSettings {
  mode: 'default' | 'application' | 'custom' | 'external';
  process_pattern: string | null;
  source_id: string | null;
  source_name: string | null;
}

interface PersonaVoiceSource {
  id: string;
  name: string;
  detail: string;
  platform: 'linux' | 'darwin' | 'win32';
}

interface PersonaVoiceSourceCatalog {
  error: string | null;
  events_url: string;
  listener: AudioListenerStatus | null;
  platform: string;
  sources: PersonaVoiceSource[];
}

interface PersonaSettingsSnapshot {
  schema_version: number;
  default_model_id: string | null;
  character_size: number;
  packaged_animation_change_count: number;
  models: PersonaModelSettings[];
  animations: PersonaAnimationSettings[];
  model_lighting: Record<string, PersonaLightingSettings>;
  voice_source: PersonaVoiceSourceSettings;
}

interface PersonaMcpStatus {
  checked_at: string;
  error: string | null;
  health: 'starting' | 'online' | 'unavailable';
  health_url: string;
  local_only: boolean;
  playable_actions: string[];
  server_url: string;
  setup_command: string;
  tools: string[];
  transport: string;
  version: string;
}

interface CustomAnimationMetadata {
  animation_name: string;
  animation_description: string;
  animation_trigger_scenario: string;
}

type AvatarBridgeEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'audio-level'; level: number; bands?: Record<string, number> }
  | {
      type: 'animation';
      animation: PersonaAnimationType | 'CUSTOM';
      animationName?: string;
      animationUrls?: string[];
      source?: 'command';
      requestId?: number;
    }
  | { type: 'listener-status'; status: AudioListenerStatus }
  | { type: 'bridge-status'; connected: boolean }
  | { type: 'avatar-driver-status'; status: AvatarDriverRuntimeStatus }
  | { type: 'avatar-state-pack'; pack: S4bAvatarPack }
  | {
      type: 'avatar-frame';
      height: number;
      sequence: number;
      sid: string;
      url: string;
      width: number;
    };

interface Window {
  personaBridge?: {
    getSnapshot(): Promise<AvatarBridgeEvent | AvatarBridgeEvent[] | null>;
    hide(): void;
    onFrameAdjustmentMode(listener: (active: boolean) => void): () => void;
    onFramePointerHold(listener: (held: boolean) => void): () => void;
    onWindowMoving(listener: (moving: boolean) => void): () => void;
    reportS4bMouthTransition(payload: {
      active: boolean;
      currentTime: number | null;
      level: number;
      paused: boolean;
      reason: 'open-threshold' | 'silence-envelope' | 'voice-not-speaking';
      voiceActivity: VoiceActivity;
    }): void;
    resizeWindow(size: { height: number; width: number }): void;
    setFrameAdjustmentMode(active: boolean): void;
    setFramePointerGeometry(payload: {
      frameRect: { bottom: number; left: number; right: number; top: number } | null;
      visible: boolean;
    }): void;
    setPointerRegion(pointerOverCharacter: boolean): void;
    showSettings(): void;
    subscribe(listener: (event: AvatarBridgeEvent) => void): () => void;
  };
  personaSettings?: {
    get(): Promise<PersonaSettingsSnapshot>;
    importModel(
      metadata: { model_name: string },
    ): Promise<PersonaSettingsSnapshot | null>;
    createAnimation(
      metadata: CustomAnimationMetadata,
    ): Promise<PersonaSettingsSnapshot>;
    addAnimationClips(
      animationId: string,
    ): Promise<PersonaSettingsSnapshot | null>;
    updateAnimation(
      animationId: string,
      metadata: CustomAnimationMetadata,
    ): Promise<PersonaSettingsSnapshot>;
    deleteAnimation(animationId: string): Promise<PersonaSettingsSnapshot>;
    deleteAnimationClip(
      animationId: string,
      clipId: string,
    ): Promise<PersonaSettingsSnapshot>;
    resetPackagedAnimations(): Promise<PersonaSettingsSnapshot>;
    deleteModel(modelId: string): Promise<PersonaSettingsSnapshot>;
    setDefaultModel(modelId: string): Promise<PersonaSettingsSnapshot>;
    setCharacterSize(size: number): Promise<PersonaSettingsSnapshot>;
    setVoiceSource(
      voiceSource: PersonaVoiceSourceSettings,
    ): Promise<PersonaSettingsSnapshot>;
    listVoiceSources(): Promise<PersonaVoiceSourceCatalog>;
    setModelLighting(
      modelId: string,
      lighting: Partial<PersonaLightingSettings>,
    ): Promise<PersonaSettingsSnapshot>;
    resetModelLighting(modelId: string): Promise<PersonaSettingsSnapshot>;
    getMcpStatus(): Promise<PersonaMcpStatus>;
    setWindowTheme(theme: 'light' | 'dark'): void;
    subscribe(
      listener: (snapshot: PersonaSettingsSnapshot) => void,
    ): () => void;
  };
}
