"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  Tray,
} = require("electron");
const { createBridgeServer, DEFAULT_PORT } = require("./bridge-server.cjs");
const { createDebugLogger } = require("./debug-logger.cjs");
const { createPersonaMcpHandler } = require("./mcp-server.cjs");
const {
  createMcpSettingsStatus,
} = require("./mcp-settings-status.cjs");
const { createSettingsStore } = require("./settings-store.cjs");
const {
  configureHyprlandWindow,
  getHyprlandWindowPlacement,
} = require("./hyprland-window.cjs");
const { createAudioListener } = require("./audio-listener.cjs");
const {
  LITEAVATAR_DRIVER_ID,
  S4B_DRIVER_ID,
  createAvatarDriverHost,
  resolveAvatarDriver,
} = require("./avatar-driver.cjs");
const {
  LiteAvatarAdapter,
  createLiteAvatarFrameResponse,
  resolveLiteAvatarWorkerPath,
} = require("./liteavatar-adapter.cjs");
const { S4bAdapter } = require("./s4b-pack.cjs");
const { listVoiceSources } = require("./voice-source-discovery.cjs");
const { isAllowedRendererNavigation } = require("./navigation-policy.cjs");
const { snapshotHasConfiguredModel } = require("./model-readiness.cjs");
const { parseProtocolUrl, voiceState } = require("./protocol-actions.cjs");
const {
  createSettingsWindowPresentationGate,
} = require("./settings-window-presentation.cjs");
const {
  normalizeVoiceSource,
  resolveVoiceSourcePattern,
  settingsPatternFromVoiceSource,
} = require("./voice-source.cjs");
const {
  FramePointerHandoff,
  WindowInteractionController,
  applyInteractionToWindow,
} = require("./window-interaction.cjs");

const WINDOW_WIDTH = 430;
const WINDOW_HEIGHT = 680;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 480;
const SETTINGS_WINDOW_WIDTH = 1180;
const SETTINGS_WINDOW_HEIGHT = 780;
// Chromium paints this behind newly exposed areas during a resize, so it must
// track the renderer's --bg-window token in src/styles.css.
const SETTINGS_WINDOW_BACKGROUND = {
  dark: "#0d0e12",
  light: "#e6e8ec",
};
const PERSONA_ASSET_SCHEME = "persona-asset";
const PERSONA_AVATAR_SCHEME = "persona-avatar";
const PERSONA_S4B_SCHEME = "persona-s4b";
const startInBackground = process.argv.includes("--background");
const startInSettings = process.argv.includes("--settings");
const protocolScheme = "persona";
const debugEnabled = process.env.PERSONA_DEBUG === "1";
const debugLogger = createDebugLogger({
  enabled: debugEnabled,
  ...(process.env.PERSONA_DEBUG_LOG
    ? { filePath: process.env.PERSONA_DEBUG_LOG }
    : {}),
});

let avatarWindow = null;
let settingsWindow = null;
let settingsWindowPresentationGate = null;
let settingsStore = null;
let bridge = null;
let mcpHandler = null;
let isQuitting = false;
let latestListenerStatus = null;
let latestVoiceState = null;
let audioListener = null;
let avatarDriver = null;
let liteAvatarAdapter = null;
let s4bAdapter = null;
let tray = null;
let debugResourceTimer = null;
let lastDebugAudioLevelAt = 0;
const windowInteraction = new WindowInteractionController();
const framePointerHandoff = new FramePointerHandoff();
const FRAME_POINTER_POLL_INTERVAL_MS = 33;
let frameAdjustmentMode = false;
let framePointerHeld = false;
let framePointerPollTimer = null;
let rendererPointerOverCharacter = false;
let windowMoveReleaseTimer = null;
let windowMoving = false;

function syncWindowInteraction(change) {
  applyInteractionToWindow(avatarWindow, change);
}

function syncPointerInteraction() {
  syncWindowInteraction(
    windowInteraction.setPointerOverCharacter(
      rendererPointerOverCharacter || framePointerHeld,
    ),
  );
}

function syncActiveInteraction() {
  syncWindowInteraction(
    windowInteraction.setInteractionActive(windowMoving || frameAdjustmentMode),
  );
}

function sendAvatarWindowEvent(channel, payload) {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  if (avatarWindow.webContents.isDestroyed()) return;
  avatarWindow.webContents.send(channel, payload);
}

function setFramePointerHeld(window, held) {
  if (avatarWindow !== window || window.isDestroyed()) return;
  const next = Boolean(held);
  if (framePointerHeld === next) return;
  framePointerHeld = next;
  syncPointerInteraction();
  sendAvatarWindowEvent("persona:frame-pointer-hold", next);
  debugLog("frame pointer hold", next);
}

function stopFramePointerPoll() {
  clearInterval(framePointerPollTimer);
  framePointerPollTimer = null;
}

function pollFramePointer(window) {
  if (avatarWindow !== window || window.isDestroyed() || !window.isVisible()) {
    stopFramePointerPoll();
    return;
  }
  const sample = framePointerHandoff.sample({
    bounds: window.getBounds(),
    cursor: screen.getCursorScreenPoint(),
  });
  if (sample.changed) setFramePointerHeld(window, sample.held);
}

function setFramePointerGeometry(window, payload) {
  if (avatarWindow !== window || window.isDestroyed()) return;
  const frameRect = payload?.visible === true ? payload.frameRect : null;
  const reset = framePointerHandoff.setFrameRect(frameRect);
  if (reset.changed) setFramePointerHeld(window, reset.held);
  if (!framePointerHandoff.frameRect) {
    stopFramePointerPoll();
    return;
  }
  pollFramePointer(window);
  if (framePointerPollTimer != null) return;
  framePointerPollTimer = setInterval(
    () => pollFramePointer(window),
    FRAME_POINTER_POLL_INTERVAL_MS,
  );
  framePointerPollTimer.unref?.();
}

function resetFramePointerHandoff(window) {
  stopFramePointerPoll();
  const reset = framePointerHandoff.reset();
  rendererPointerOverCharacter = false;
  if (reset.changed) setFramePointerHeld(window, false);
  else {
    framePointerHeld = false;
    syncPointerInteraction();
  }
}

function resetWindowInteraction(window) {
  resetFramePointerHandoff(window);
  windowInteraction.reset();
  syncPointerInteraction();
  syncActiveInteraction();
  syncWindowInteraction(windowInteraction.resolve());
}

function setFrameAdjustmentMode(active) {
  const next = Boolean(active);
  if (frameAdjustmentMode === next) return;
  frameAdjustmentMode = next;
  syncActiveInteraction();
  sendAvatarWindowEvent("persona:frame-adjustment-mode", next);
  debugLog("frame adjustment mode", next);
  refreshTrayMenu();
}

function setWindowMoving(window, moving) {
  if (avatarWindow !== window || window.isDestroyed()) return;
  const next = Boolean(moving);
  const changed = windowMoving !== next;
  windowMoving = next;
  syncActiveInteraction();
  if (!changed) return;
  if (!window.webContents.isDestroyed()) {
    window.webContents.send("persona:window-moving", next);
  }
  debugLog("window moving", next);
}

function holdWindowInteractionForMove(window) {
  clearTimeout(windowMoveReleaseTimer);
  setWindowMoving(window, true);
  windowMoveReleaseTimer = setTimeout(() => {
    windowMoveReleaseTimer = null;
    setWindowMoving(window, false);
  }, 250);
  windowMoveReleaseTimer.unref?.();
}
let hyprlandConfigured = false;
let hyprlandConfiguring = false;
let hyprlandConfigurationTimer = null;
let hyprlandLastPosition = null;
let hyprlandConfigurationGeneration = 0;
let rendererLoadHookAttached = false;
let animationCommandRequestId = 0;
let modelConfigured = false;
let mcpServerError = null;
let mcpServerHealth = "starting";
let mcpServerPort = Number(
  process.env.PERSONA_BRIDGE_PORT || DEFAULT_PORT,
);
let mcpAnimationCatalogSignature = null;
const pendingRendererEvents = new Map();
const rendererSnapshotEvents = new Map();
const SNAPSHOT_EVENT_TYPES = new Set([
  "audio-level",
  "avatar-driver-status",
  "avatar-frame",
  "avatar-state-pack",
  "bridge-status",
  "listener-status",
  "state",
]);

protocol.registerSchemesAsPrivileged([
  {
    scheme: PERSONA_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: PERSONA_AVATAR_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: PERSONA_S4B_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
app.setName("Persona");

function debugLog(...values) {
  debugLogger.log(...values);
}

function startDebugResourceTelemetry() {
  if (!debugEnabled || debugResourceTimer) return;
  const sample = () => {
    const processes = app.getAppMetrics().map((metric) => ({
      cpuPercent: Math.round((metric.cpu?.percentCPUUsage ?? 0) * 10) / 10,
      memoryMb:
        Math.round(((metric.memory?.workingSetSize ?? 0) / 1024) * 10) / 10,
      pid: metric.pid,
      type: metric.type,
    }));
    debugLog("resource sample", { processes });
  };
  sample();
  debugResourceTimer = setInterval(sample, 5_000);
  debugResourceTimer.unref?.();
}

function positionWindow(window) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = window.getBounds();
  const margin = 24;
  window.setPosition(
    Math.round(display.workArea.x + display.workArea.width - bounds.width - margin),
    Math.round(display.workArea.y + display.workArea.height - bounds.height - margin),
    false,
  );
}

function hasConfiguredModel() {
  return modelConfigured;
}

function scheduleHyprlandWindowConfiguration({
  attempt = 0,
  force = false,
  position = null,
  reposition = !hyprlandConfigured,
} = {}) {
  if (
    (hyprlandConfigured && !force) ||
    hyprlandConfiguring ||
    !avatarWindow ||
    avatarWindow.isDestroyed()
  ) {
    return;
  }
  clearTimeout(hyprlandConfigurationTimer);
  const generation = hyprlandConfigurationGeneration;
  const targetWindow = avatarWindow;
  const delays = [0, 80, 200, 500, 1000];
  hyprlandConfigurationTimer = setTimeout(async () => {
    hyprlandConfigurationTimer = null;
    if (
      generation !== hyprlandConfigurationGeneration ||
      !avatarWindow ||
      avatarWindow !== targetWindow ||
      avatarWindow.isDestroyed()
    ) {
      return;
    }
    hyprlandConfiguring = true;
    const configured = await configureHyprlandWindow({
      pid: process.pid,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      onDebug: debugLog,
      position,
      reposition,
    });
    if (generation !== hyprlandConfigurationGeneration) return;
    hyprlandConfigured = configured;
    hyprlandConfiguring = false;
    if (!hyprlandConfigured && attempt + 1 < delays.length) {
      scheduleHyprlandWindowConfiguration({
        attempt: attempt + 1,
        force: true,
        position,
        reposition,
      });
    }
  }, delays[attempt] ?? delays.at(-1));
  hyprlandConfigurationTimer.unref?.();
}

function showOverlay({ focus = false } = {}) {
  if (!hasConfiguredModel()) {
    showSettings();
    return;
  }
  const window = createWindow();
  if (window.isMinimized()) window.restore();
  if (focus) {
    if (!window.isVisible()) window.show();
    window.focus();
  } else if (!window.isVisible()) {
    window.showInactive();
  }
  scheduleHyprlandWindowConfiguration();
}

async function hideOverlay() {
  debugLog("hide overlay");
  const targetWindow = avatarWindow;
  if (!targetWindow || targetWindow.isDestroyed()) return;
  setFrameAdjustmentMode(false);
  resetFramePointerHandoff(targetWindow);
  const placement = await getHyprlandWindowPlacement(process.pid);
  if (avatarWindow !== targetWindow || targetWindow.isDestroyed()) return;
  if (placement) {
    hyprlandLastPosition = { x: placement.x, y: placement.y };
  }
  targetWindow.hide();
}

function destroyOverlayForSetup() {
  clearTimeout(hyprlandConfigurationTimer);
  clearTimeout(windowMoveReleaseTimer);
  hyprlandConfigurationGeneration += 1;
  hyprlandConfigurationTimer = null;
  windowMoveReleaseTimer = null;
  windowMoving = false;
  frameAdjustmentMode = false;
  stopFramePointerPoll();
  framePointerHandoff.reset();
  framePointerHeld = false;
  rendererPointerOverCharacter = false;
  hyprlandConfigured = false;
  hyprlandConfiguring = false;
  hyprlandLastPosition = null;
  rendererLoadHookAttached = false;
  pendingRendererEvents.clear();
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.destroy();
  }
  avatarWindow = null;
}

function toggleOverlay() {
  if (!hasConfiguredModel()) {
    showSettings();
    return;
  }
  if (avatarWindow?.isVisible()) void hideOverlay();
  else showOverlay({ focus: true });
}

function rendererUrl(view = null) {
  const url = new URL(
    process.env.VITE_DEV_SERVER_URL ||
      pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href,
  );
  if (view) url.searchParams.set("view", view);
  return url.href;
}

function secureRendererWindow(window, allowedRendererUrl) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, allowedRendererUrl)) {
      event.preventDefault();
    }
  });
}

function createWindow() {
  if (avatarWindow && !avatarWindow.isDestroyed()) return avatarWindow;

  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "Persona",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  avatarWindow = window;
  // Some adapters publish their complete surface only once during startup.
  // Always flush those retained events into a newly created renderer, even if
  // no later voice event happens while the document is loading.
  rendererLoadHookAttached = true;
  window.webContents.once("did-finish-load", flushPendingRendererEvents);

  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setOpacity(1);
  // A fresh BrowserWindow accepts the pointer across its whole rectangle, which
  // would swallow clicks aimed at the applications underneath the transparent
  // area. Start pass-through and let the renderer re-enable interaction while
  // the pointer is over the character.
  resetWindowInteraction(window);
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    positionWindow(window);
    scheduleHyprlandWindowConfiguration();
  });
  window.on("show", () => {
    if (window.isDestroyed()) return;
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setOpacity(1);
    resetWindowInteraction(window);
    scheduleHyprlandWindowConfiguration({
      force: true,
      position: hyprlandLastPosition,
      reposition: !hyprlandConfigured || hyprlandLastPosition != null,
    });
  });
  // Chromium temporarily loses normal pointer tracking while a frameless
  // macOS app-region is being dragged. Latch both renderer chrome and native
  // mouse acceptance across that gap so auto pass-through cannot cancel the
  // move it just started. Electron emits `move` continuously on macOS, so a
  // short trailing debounce marks the end of the native gesture.
  window.on("will-move", () => holdWindowInteractionForMove(window));
  window.on("move", () => holdWindowInteractionForMove(window));
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void hideOverlay();
  });
  window.on("closed", () => {
    if (avatarWindow !== window) return;
    clearTimeout(hyprlandConfigurationTimer);
    clearTimeout(windowMoveReleaseTimer);
    stopFramePointerPoll();
    framePointerHandoff.reset();
    framePointerHeld = false;
    rendererPointerOverCharacter = false;
    frameAdjustmentMode = false;
    hyprlandConfigurationTimer = null;
    windowMoveReleaseTimer = null;
    windowMoving = false;
    hyprlandConfigured = false;
    hyprlandConfiguring = false;
    rendererLoadHookAttached = false;
    avatarWindow = null;
  });

  const avatarRendererUrl = rendererUrl();
  secureRendererWindow(window, avatarRendererUrl);
  void window.loadURL(avatarRendererUrl);
  return window;
}

function settingsWindowBackground(theme) {
  return SETTINGS_WINDOW_BACKGROUND[theme] ?? SETTINGS_WINDOW_BACKGROUND.dark;
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow;

  const window = new BrowserWindow({
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: "Persona Settings",
    // Best guess until the renderer reports the theme it actually resolved,
    // which it does before the window is shown on ready-to-show.
    backgroundColor: settingsWindowBackground(
      nativeTheme.shouldUseDarkColors ? "dark" : "light",
    ),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const presentationGate = createSettingsWindowPresentationGate();
  settingsWindow = window;
  settingsWindowPresentationGate = presentationGate;

  const settingsRendererUrl = rendererUrl("settings");
  secureRendererWindow(window, settingsRendererUrl);
  window.once("ready-to-show", () => {
    if (
      settingsWindow !== window ||
      settingsWindowPresentationGate !== presentationGate
    ) {
      return;
    }
    if (presentationGate.markReadyToShow()) focusSettingsWindow();
  });
  window.on("closed", () => {
    if (settingsWindow !== window) return;
    settingsWindow = null;
    settingsWindowPresentationGate = null;
  });
  void window.loadURL(settingsRendererUrl);
  return window;
}

function focusSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  settingsWindow.setFocusable(true);
  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.show();
  settingsWindow.moveTop();
  settingsWindow.focus();
  settingsWindow.webContents.focus();
}

function showSettings() {
  const window = createSettingsWindow();
  if (settingsWindowPresentationGate?.requestShow()) {
    focusSettingsWindow();
  }
  return window;
}

function animationCatalogSignature(snapshot) {
  return JSON.stringify(
    snapshot.animations.map((animation) => ({
      description: animation.animation_description,
      id: animation.id,
      name: animation.animation_name,
      playableClipCount: animation.asset_urls.length,
      trigger: animation.animation_trigger_scenario,
    })),
  );
}

function publishSettings(snapshot) {
  const wasConfigured = modelConfigured;
  modelConfigured = snapshotHasConfiguredModel(snapshot);
  const nextAnimationCatalogSignature = animationCatalogSignature(snapshot);
  if (nextAnimationCatalogSignature !== mcpAnimationCatalogSignature) {
    mcpAnimationCatalogSignature = nextAnimationCatalogSignature;
    mcpHandler?.notifyToolsChanged();
  }
  for (const window of [avatarWindow, settingsWindow]) {
    if (window && !window.isDestroyed() && !window.webContents.isLoading()) {
      window.webContents.send("persona:settings-updated", snapshot);
    }
  }
  refreshTrayMenu();
  if (!wasConfigured && modelConfigured) {
    avatarDriver?.start();
    void audioListener?.start();
    showOverlay();
  } else if (wasConfigured && !modelConfigured) {
    audioListener?.stop();
    const inactiveState = voiceState("idle", "inactive");
    latestVoiceState = inactiveState.state;
    emitToRenderer(inactiveState);
    destroyOverlayForSetup();
    setImmediate(focusSettingsWindow);
  }
  return snapshot;
}

function resolveListenerProcessPattern(snapshot = settingsStore?.getSnapshot()) {
  const voiceSource = normalizeVoiceSource(snapshot?.voice_source);
  if (!["default", "custom"].includes(voiceSource.mode)) return null;
  return resolveVoiceSourcePattern({
    environment: process.env,
    settingsPattern: settingsPatternFromVoiceSource(voiceSource),
  });
}

function createConfiguredAudioListener(snapshot = settingsStore?.getSnapshot()) {
  const voiceSource = normalizeVoiceSource(snapshot?.voice_source);
  return createAudioListener({
    emitPcm: avatarDriver?.requiresPcm ?? false,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    processPattern: resolveListenerProcessPattern(snapshot),
    voiceSource,
    onActivity: (activity) => {
      debugLog("listener activity", activity);
      handleBridgeEvent(voiceState(activity));
    },
    onDebug: debugEnabled
      ? (...details) => debugLog("listener diagnostics", ...details)
      : null,
    onLevel: (level) => handleBridgeEvent({ type: "audio-level", level }),
    onPcm: (frame) => avatarDriver?.handlePcm(frame),
    onSession: (active) => {
      debugLog("listener session", active);
      handleBridgeEvent(voiceState(active ? "listening" : "idle", active ? "active" : "inactive"));
    },
    onStatus: (status) => {
      debugLog("listener status", status);
      handleListenerStatus(status);
    },
  });
}

function reportInactiveListenerStatus(snapshot = settingsStore?.getSnapshot()) {
  const voiceSource = normalizeVoiceSource(snapshot?.voice_source);
  handleListenerStatus({
    available: voiceSource.mode === "external",
    capturing: false,
    monitoring: false,
    source:
      voiceSource.mode === "external" ? "External integration" : null,
  });
}

function restartAudioListener() {
  audioListener?.stop();
  audioListener = createConfiguredAudioListener();
  if (audioListener && modelConfigured) {
    void audioListener.start();
  } else if (audioListener) {
    handleListenerStatus({
      available: true,
      capturing: false,
      monitoring: false,
      source: null,
    });
  } else {
    reportInactiveListenerStatus();
  }
}

function playConfiguredAnimation(animationName) {
  if (!hasConfiguredModel()) return false;
  const installedAnimation = settingsStore?.getAnimation(animationName);
  if (
    installedAnimation == null ||
    installedAnimation.asset_urls.length === 0
  ) {
    return false;
  }
  animationCommandRequestId += 1;
  handleBridgeEvent({
    type: "animation",
    animation: installedAnimation.animation_type ?? "CUSTOM",
    animationName: installedAnimation.animation_name,
    animationUrls: installedAnimation.asset_urls,
    source: "command",
    requestId: animationCommandRequestId,
  });
  return true;
}

async function selectAssetFile(kind, multiple = false) {
  const extension = kind === "model" ? "vrm" : "vrma";
  const options = {
    title: kind === "model" ? "Add a VRM model" : "Add a VRMA animation",
    properties: ["openFile", ...(multiple ? ["multiSelections"] : [])],
    filters: [
      {
        name: kind === "model" ? "VRM models" : "VRMA animations",
        extensions: [extension],
      },
    ],
  };
  const result =
    settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showOpenDialog(settingsWindow, options)
      : await dialog.showOpenDialog(options);
  if (result.canceled) return multiple ? [] : null;
  return multiple ? result.filePaths : result.filePaths[0] ?? null;
}

function flushPendingRendererEvents() {
  rendererLoadHookAttached = false;
  if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isLoading()) return;
  for (const event of pendingRendererEvents.values()) {
    avatarWindow.webContents.send("persona:event", event);
  }
  pendingRendererEvents.clear();
}

function ensureRendererLoadHook() {
  if (
    rendererLoadHookAttached ||
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    !avatarWindow.webContents.isLoading()
  ) {
    return;
  }
  rendererLoadHookAttached = true;
  avatarWindow.webContents.once("did-finish-load", flushPendingRendererEvents);
}

function emitToRenderer(event) {
  if (SNAPSHOT_EVENT_TYPES.has(event.type)) {
    rendererSnapshotEvents.set(event.type, event);
  }
  pendingRendererEvents.set(event.type, event);
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  if (avatarWindow.webContents.isLoading()) {
    ensureRendererLoadHook();
    return;
  }
  avatarWindow.webContents.send("persona:event", event);
  pendingRendererEvents.delete(event.type);
}

function handleBridgeEvent(event) {
  if (event.type !== "audio-level") {
    debugLog("event", event);
  } else if (event.level > 0.025 && Date.now() - lastDebugAudioLevelAt >= 250) {
    lastDebugAudioLevelAt = Date.now();
    debugLog("event", event);
  }
  const canShowAvatar = hasConfiguredModel();
  if (event.type === "state") {
    latestVoiceState = event.state;
    if (
      canShowAvatar &&
      (event.state.phase === "starting" || event.state.phase === "active")
    ) {
      showOverlay();
    }
  } else if (
    canShowAvatar &&
    event.type === "audio-level" &&
    event.level > 0.025
  ) {
    showOverlay();
  } else if (canShowAvatar && event.type === "animation") {
    showOverlay();
  }
  if (canShowAvatar) {
    if (avatarDriver) avatarDriver.handleEvent(event);
    else emitToRenderer(event);
  }
}

function handleIntegrationEvent(event) {
  if (event.type === "animation-command") {
    return playConfiguredAnimation(event.animationName);
  }
  handleBridgeEvent(event);
  return true;
}

function handleListenerStatus(status) {
  latestListenerStatus = status;
  if (hasConfiguredModel()) {
    emitToRenderer({ type: "listener-status", status });
  }
}

async function handleMcpWindowAction(action) {
  if (!hasConfiguredModel()) return false;
  if (action === "show") showOverlay({ focus: true });
  else if (action === "hide") await hideOverlay();
  else if (avatarWindow?.isVisible()) await hideOverlay();
  else showOverlay({ focus: true });
  return avatarWindow?.isVisible() ?? false;
}

function getMcpStatus() {
  return {
    modelConfigured: hasConfiguredModel(),
    windowVisible: avatarWindow?.isVisible() ?? false,
    voiceState: latestVoiceState,
    listener: latestListenerStatus,
    avatarDriver: avatarDriver?.getStatus() ?? null,
  };
}

function handleProtocolUrl(rawUrl) {
  const commands = parseProtocolUrl(rawUrl, protocolScheme);
  if (!commands) return false;
  let handled = true;
  for (const command of commands) {
    if (command.type === "show") showOverlay({ focus: true });
    else if (command.type === "hide") void hideOverlay();
    else if (command.type === "toggle") toggleOverlay();
    else if (command.type === "event") handleBridgeEvent(command.event);
    else if (command.type === "animation-command") {
      handled = playConfiguredAnimation(command.animationName) && handled;
    }
  }
  return handled;
}

function handleProtocolArgv(argv) {
  const protocolUrl = argv.find((value) => value.startsWith(`${protocolScheme}://`));
  if (protocolUrl) handleProtocolUrl(protocolUrl);
}

function refreshTrayMenu() {
  if (!tray) return;
  const ready = hasConfiguredModel();
  const quitItem = {
    label: "Quit",
    click: () => {
      isQuitting = true;
      app.quit();
    },
  };
  const template = ready
    ? [
        { label: "Show Persona", click: () => showOverlay({ focus: true }) },
        { label: "Hide Persona", click: () => void hideOverlay() },
        { label: "Settings…", click: showSettings },
        { type: "separator" },
        {
          label: "Adjust position and size",
          type: "checkbox",
          checked: frameAdjustmentMode,
          toolTip:
            "Pin Persona's frame and mouse controls until you finish or press Escape.",
          click: (item) => {
            showOverlay();
            setFrameAdjustmentMode(item.checked);
          },
        },
        {
          label: "Always interactive",
          type: "checkbox",
          checked: windowInteraction.mode === "always",
          toolTip:
            "Keep the whole Persona window clickable. Off means clicks pass " +
            "through to the app underneath unless the pointer is on the character.",
          click: (item) => {
            syncWindowInteraction(
              windowInteraction.setMode(item.checked ? "always" : "auto"),
            );
            refreshTrayMenu();
          },
        },
        { type: "separator" },
        {
          label: "Preview listening",
          click: () => handleBridgeEvent(voiceState("listening")),
        },
        {
          label: "Preview thinking",
          click: () => handleBridgeEvent(voiceState("thinking")),
        },
        {
          label: "Preview speaking",
          click: () => handleBridgeEvent(voiceState("speaking")),
        },
        { type: "separator" },
        quitItem,
      ]
    : [
        { label: "Set up Persona…", click: showSettings },
        { type: "separator" },
        quitItem,
      ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const iconPath = path.join(
    __dirname,
    "..",
    app.isPackaged ? "dist" : "public",
    "assets",
    "avatar.png",
  );
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("Persona");
  refreshTrayMenu();
  tray.on("click", toggleOverlay);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const handled = argv.some((value) => value.startsWith(`${protocolScheme}://`));
    handleProtocolArgv(argv);
    if (argv.includes("--settings")) showSettings();
    else if (!handled && !argv.includes("--background")) showOverlay({ focus: true });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("com.xikhar.persona");
    app.dock?.hide();
    debugLog("run started", {
      debugLog: debugLogger.filePath,
      pid: process.pid,
      requestedAvatarDriver: process.env.PERSONA_AVATAR_DRIVER || "vrm",
    });
    startDebugResourceTelemetry();
    if (app.isPackaged) app.setAsDefaultProtocolClient(protocolScheme);
    settingsStore = createSettingsStore({
      userDataPath: app.getPath("userData"),
      packagedLibraryPath: path.join(
        __dirname,
        "..",
        app.isPackaged ? "dist" : "public",
        "assets",
        "library.json",
      ),
    });
    const initialSettingsSnapshot = settingsStore.getSnapshot();
    const selectedAvatarDriver = resolveAvatarDriver(
      process.env.PERSONA_AVATAR_DRIVER,
    ).driver.id;
    if (selectedAvatarDriver === LITEAVATAR_DRIVER_ID) {
      liteAvatarAdapter = new LiteAvatarAdapter({
        onDebug: (...details) => debugLog("liteavatar", ...details),
        onFrame: ({ height, sequence, sid, width }) => {
          emitToRenderer({
            type: "avatar-frame",
            height,
            sequence,
            sid,
            url: `${PERSONA_AVATAR_SCHEME}://frame/${sequence}`,
            width,
          });
        },
        onStatus: (status) => {
          emitToRenderer({
            type: "avatar-driver-status",
            status: { ...status, driverId: LITEAVATAR_DRIVER_ID },
          });
        },
        workerPath: resolveLiteAvatarWorkerPath({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
        }),
      });
    } else if (selectedAvatarDriver === S4B_DRIVER_ID) {
      s4bAdapter = new S4bAdapter({
        onPack: emitToRenderer,
        onStatus: (status) => {
          emitToRenderer({ type: "avatar-driver-status", status });
        },
      });
    }
    avatarDriver = createAvatarDriverHost({
      adapter: liteAvatarAdapter ?? s4bAdapter,
      driverId: process.env.PERSONA_AVATAR_DRIVER,
      onDebug: (...details) => debugLog("avatar driver", ...details),
      onRendererEvent: emitToRenderer,
    });
    debugLog("avatar driver initialized", avatarDriver.getStatus());
    modelConfigured = snapshotHasConfiguredModel(initialSettingsSnapshot);
    mcpAnimationCatalogSignature = animationCatalogSignature(
      initialSettingsSnapshot,
    );
    protocol.handle(PERSONA_ASSET_SCHEME, (request) => {
      const assetPath = settingsStore?.resolveAssetRequest(request.url);
      if (!assetPath) {
        return new Response("Asset not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(assetPath).href);
    });
    protocol.handle(PERSONA_AVATAR_SCHEME, (request) =>
      createLiteAvatarFrameResponse(liteAvatarAdapter, request.url),
    );
    protocol.handle(PERSONA_S4B_SCHEME, async (request) => {
      const media = s4bAdapter?.resolveMediaRequest(request.url);
      if (!media) return new Response("S4b clip not found", { status: 404 });
      const response = await net.fetch(pathToFileURL(media.filePath).href, {
        headers: request.headers,
      });
      const headers = new Headers(response.headers);
      headers.set("content-type", media.mimeType);
      headers.set("cache-control", "private, max-age=3600");
      return new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    });
    if (modelConfigured) avatarDriver.start();

    ipcMain.handle("persona:get-snapshot", () => [
      ...rendererSnapshotEvents.values(),
    ]);
    ipcMain.handle("persona:settings-get", () => settingsStore.getSnapshot());
    ipcMain.handle("persona:settings-import-model", async (_event, metadata) => {
      const filePath = await selectAssetFile("model");
      if (!filePath) return null;
      return publishSettings(
        settingsStore.importModel({ filePath, model_name: metadata?.model_name }),
      );
    });
    ipcMain.handle("persona:settings-create-animation", (_event, metadata) =>
      publishSettings(settingsStore.createAnimation(metadata)),
    );
    ipcMain.handle(
      "persona:settings-add-animation-clips",
      async (_event, animationId) => {
        const filePaths = await selectAssetFile("animation", true);
        if (filePaths.length === 0) return null;
        return publishSettings(
          settingsStore.addAnimationClips(animationId, filePaths),
        );
      },
    );
    ipcMain.handle(
      "persona:settings-update-animation",
      (_event, animationId, metadata) =>
        publishSettings(
          settingsStore.updateAnimation(animationId, metadata),
        ),
    );
    ipcMain.handle(
      "persona:settings-delete-animation",
      (_event, animationId) =>
        publishSettings(settingsStore.deleteAnimation(animationId)),
    );
    ipcMain.handle(
      "persona:settings-delete-animation-clip",
      (_event, animationId, clipId) =>
        publishSettings(
          settingsStore.deleteAnimationClip(animationId, clipId),
        ),
    );
    ipcMain.handle(
      "persona:settings-reset-packaged-animations",
      () => publishSettings(settingsStore.resetPackagedAnimations()),
    );
    ipcMain.handle(
      "persona:settings-delete-model",
      (_event, modelId) => {
        const model = settingsStore
          .getSnapshot()
          .models.find((candidate) => candidate.id === modelId);
        if (!model?.removable) {
          throw new Error("Packaged models cannot be deleted.");
        }
        return publishSettings(settingsStore.deleteModel(modelId));
      },
    );
    ipcMain.handle("persona:settings-set-default-model", (_event, modelId) =>
      publishSettings(settingsStore.setDefaultModel(modelId)),
    );
    ipcMain.handle("persona:settings-set-character-size", (_event, size) =>
      publishSettings(settingsStore.setCharacterSize(size)),
    );
    ipcMain.handle("persona:settings-set-voice-source", (_event, voiceSource) => {
      const snapshot = publishSettings(settingsStore.setVoiceSource(voiceSource));
      restartAudioListener();
      return snapshot;
    });
    ipcMain.handle("persona:settings-list-voice-sources", async () => {
      try {
        return {
          ...(await listVoiceSources()),
          error: null,
          events_url: `http://127.0.0.1:${mcpServerPort}/events`,
          listener: latestListenerStatus,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          events_url: `http://127.0.0.1:${mcpServerPort}/events`,
          listener: latestListenerStatus,
          platform: process.platform,
          sources: [],
        };
      }
    });
    ipcMain.handle(
      "persona:settings-set-model-lighting",
      (_event, modelId, lighting) =>
        publishSettings(settingsStore.setModelLighting(modelId, lighting)),
    );
    ipcMain.handle(
      "persona:settings-reset-model-lighting",
      (_event, modelId) =>
        publishSettings(settingsStore.resetModelLighting(modelId)),
    );
    ipcMain.handle("persona:settings-get-mcp-status", () =>
      createMcpSettingsStatus({
        error: mcpServerError,
        health: mcpServerHealth,
        port: mcpServerPort,
        settingsSnapshot: settingsStore.getSnapshot(),
      }),
    );
    ipcMain.on("persona:pointer-region", (event, pointerOverCharacter) => {
      if (avatarWindow?.webContents !== event.sender) return;
      rendererPointerOverCharacter = Boolean(pointerOverCharacter);
      syncPointerInteraction();
    });
    ipcMain.on("persona:frame-pointer-geometry", (event, payload) => {
      if (avatarWindow?.webContents !== event.sender || avatarWindow.isDestroyed()) {
        return;
      }
      setFramePointerGeometry(avatarWindow, payload);
      sendAvatarWindowEvent(
        "persona:frame-adjustment-mode",
        frameAdjustmentMode,
      );
    });
    ipcMain.on("persona:set-frame-adjustment-mode", (event, active) => {
      if (avatarWindow?.webContents !== event.sender) return;
      setFrameAdjustmentMode(active);
    });
    ipcMain.on("persona:s4b-mouth-transition", (event, payload) => {
      if (avatarWindow?.webContents !== event.sender) return;
      const currentTime = Number(payload?.currentTime);
      const level = Number(payload?.level);
      const reason = ["open-threshold", "silence-envelope", "voice-not-speaking"].includes(
        payload?.reason,
      )
        ? payload.reason
        : "unknown";
      debugLog("s4b mouth transition", {
        active: Boolean(payload?.active),
        currentTime: Number.isFinite(currentTime) ? currentTime : null,
        level: Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : null,
        paused: Boolean(payload?.paused),
        reason,
        voiceActivity: ["idle", "listening", "thinking", "speaking"].includes(
          payload?.voiceActivity,
        )
          ? payload.voiceActivity
          : "idle",
      });
    });
    ipcMain.on("persona:show-settings", (event) => {
      if (avatarWindow?.webContents !== event.sender) return;
      showSettings();
    });
    ipcMain.on("persona:resize-window", (event, size) => {
      if (avatarWindow?.webContents !== event.sender || avatarWindow.isDestroyed()) {
        return;
      }
      const width = Number(size?.width);
      const height = Number(size?.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return;
      const bounds = avatarWindow.getBounds();
      // Anchor the top-left corner so the character grows toward the bottom
      // right, matching where the resize grip is.
      avatarWindow.setBounds({
        height: Math.max(MIN_WINDOW_HEIGHT, Math.round(height)),
        width: Math.max(MIN_WINDOW_WIDTH, Math.round(width)),
        x: bounds.x,
        y: bounds.y,
      });
    });
    ipcMain.on("persona:hide", () => void hideOverlay());
    // The resolved theme lives in renderer storage, so the window chrome can
    // only be corrected once the settings renderer reports it. Accepts the two
    // known theme names and never a caller-supplied colour.
    ipcMain.on("persona:settings-set-window-theme", (event, theme) => {
      if (theme !== "dark" && theme !== "light") return;
      if (!settingsWindow || settingsWindow.isDestroyed()) return;
      if (event.sender !== settingsWindow.webContents) return;
      const background = settingsWindowBackground(theme);
      settingsWindow.setBackgroundColor(background);
      debugLog("settings window background", theme, background);
      if (settingsWindowPresentationGate?.markThemeApplied()) {
        focusSettingsWindow();
      }
    });

    mcpHandler = createPersonaMcpHandler({
      onAnimation: playConfiguredAnimation,
      onWindowAction: handleMcpWindowAction,
      getStatus: getMcpStatus,
      getAnimations: () =>
        settingsStore
          .getSnapshot()
          .animations.filter((animation) => animation.asset_urls.length > 0),
    });
    bridge = createBridgeServer({
      port: mcpServerPort,
      onEvent: handleIntegrationEvent,
      mcpHandler,
    });
    try {
      const address = await bridge.listen();
      if (address && typeof address === "object") {
        mcpServerPort = address.port;
      }
      mcpServerHealth = "online";
      mcpServerError = null;
    } catch (error) {
      mcpServerHealth = "unavailable";
      mcpServerError =
        error instanceof Error ? error.message : String(error);
      console.error(
        "[persona] local integration server unavailable:",
        mcpServerError,
      );
      bridge = null;
    }

    createTray();
    globalShortcut.register("CommandOrControl+Shift+A", toggleOverlay);
    handleProtocolArgv(process.argv);

    audioListener = createConfiguredAudioListener();
    if (audioListener && modelConfigured) {
      void audioListener.start();
    } else if (audioListener) {
      handleListenerStatus({
        available: true,
        capturing: false,
        monitoring: false,
        source: null,
      });
    } else {
      reportInactiveListenerStatus();
    }

    if (!modelConfigured || startInSettings) {
      showSettings();
    } else if (!startInBackground) {
      createWindow();
      showOverlay({ focus: true });
    }
  });
}

app.on("activate", () => showOverlay({ focus: true }));

app.on("before-quit", () => {
  isQuitting = true;
  debugLog("run stopping");
  clearInterval(debugResourceTimer);
  debugResourceTimer = null;
  clearTimeout(windowMoveReleaseTimer);
  windowMoveReleaseTimer = null;
  clearTimeout(hyprlandConfigurationTimer);
  audioListener?.stop();
  void avatarDriver?.stop();
  globalShortcut.unregisterAll();
  void mcpHandler?.close();
  void bridge
    ?.close()
    .catch((error) => debugLog("integration server close failed", error));
});

app.on("window-all-closed", () => {
  // The tray, protocol handler, and adapter server keep Persona available.
});
