# Developing Persona

## Architecture

Persona has five intentionally narrow layers:

1. Native listeners discover a supported voice process and calculate a
   normalized output level. The macOS helper can produce bounded PCM only for
   an explicitly selected internal driver.
2. Avatar Driver v1 validates state, level, and animation events and owns the
   optional in-memory PCM adapter queue.
3. The Electron main process owns lifecycle, window behavior, tray commands,
   URL handling, the local adapter, and Persona's MCP controls.
4. The sandboxed preload exposes only normalized Persona events and narrow
   settings operations.
5. React renders the Three.js VRM model, a bounded local LiteAvatar frame
   surface, or an S4b single-video surface. Renderer code cannot see PCM or file
   paths; it receives only validated custom-protocol URLs.

No renderer code has filesystem, process, or raw-audio access.

The driver contract, capability matrix, opt-in command, PCM backpressure, and
renderer trade-offs are documented in [AVATAR_DRIVER.md](AVATAR_DRIVER.md).

## Settings and local media

`public/assets/library.json` declares the immutable library shipped with the
application. It contains packaged models plus animation action names,
descriptions, trigger scenarios, runtime types, and media paths. The release asset validator
derives its expected media from this catalog instead of a second hard-coded
list.

The active catalog contains the permanent Idle, Thinking, and Speaking action
slots but declares no character media during first-run development.
`library.json.example` and `manifest.json.example` are complete, directly
copyable examples for the ignored local test media. Packaged models live under
`public/assets/models/` and animations under `public/assets/animations/`. When
a non-empty catalog omits an explicit default, its first model becomes active.

`electron/settings-store.cjs` owns the mutable per-user library and merges it
with the packaged catalog. Animation actions and their VRMA clips are separate
records: an action owns MCP metadata and can contain multiple numbered clips.
The renderer sends metadata through the sandboxed preload, the main process
opens the native multi-file picker, validates every selected glTF 2 binary, and
copies it under Electron's per-user application-data directory.

User media is exposed to renderers through the locked `persona-asset:`
protocol. Requests resolve only IDs already present in the settings store; a
renderer cannot turn the protocol into an arbitrary local-file reader.

LiteAvatar frames use the separate `persona-avatar:` protocol. It serves only
the adapter's latest validated in-memory JPEG, never a filesystem path. A
requested sequence cannot address older media or arbitrary local data.
The React surface uses two image elements: one stays visible while the other
decodes the latest available frame. This avoids a blank compositor layer when
25 changing no-cache URLs outrun Chromium image decode.

S4b media uses the separate `persona-s4b:` protocol. The main process resolves
only clip IDs from a validated pack; relative paths and symlinks must remain
inside that pack. React keeps one speaking video mounted as the sole visible
surface and holds its own predecoded neutral frame above it while silent. The
speaking loop starts on an above-threshold level and returns to that canvas
after a 320 ms dual-threshold silence envelope. Voice-state changes never swap the full-frame
source, and audio level
never changes playback speed, and silence events do not seek the visible video.
See [S4B.md](S4B.md).

Packaged files are never mutated. Editing packaged action metadata creates a
copy-on-write override, and removing one creates a user-level visibility
tombstone. Resetting packaged actions clears only those overrides and
tombstones; user-created actions and uploaded clips remain unchanged. Idle,
Thinking, and Speaking cannot be edited or removed, but users can add or remove
their local clips.

The store returns one active snapshot containing the default model, character
size, merged model records, merged action records with clip collections, and the
configured voice source. Only actions with at least one playable clip appear in
the MCP tool description and animation listing. Catalog changes refresh
connected MCP sessions immediately, while every animation request is validated
against the current store snapshot. Keep the catalog, store, MCP, and
asset-contract tests in sync when adding fields or changing validation.

An empty packaged catalog is a supported first-run state. The application opens
Settings and does not create the avatar window or start the audio listener until
the merged snapshot has a valid `default_model_id`. Importing the first user
model selects it automatically. Empty Idle, Thinking, or Speaking actions use
an empty animation URL list, which activates the renderer's lightweight
procedural-motion fallback. The fallback lowers T-pose arms and adds breathing,
sway, and head motion; Speaking also adds subtle nods. A configured VRMA clip
takes priority for its action and disables the fallback until that action
becomes empty again.

## MCP contract

`electron/mcp-server.cjs` owns the Codex-facing tool schemas and translates
validated tool calls into narrow main-process callbacks. It does not receive
the Electron application object, renderer access, arbitrary animation paths, or
shell execution.

The loopback server creates a stateful Streamable HTTP transport when a client
initializes an MCP session, then routes subsequent `POST`, `GET`, and `DELETE`
requests by session ID. Active sessions receive tool-list change notifications
when the playable action catalog changes. New sessions always discover the
latest catalog, and `play_animation` checks the live store again when invoked.
MCP shares the existing local integration port rather than opening another
listener.

When extending the server:

- prefer a small product action over exposing an internal Electron primitive;
- validate every argument with a bounded schema and, where applicable, the
  current settings catalog;
- mark read-only and side-effecting tools accurately;
- keep the server instructions self-contained; and
- add a protocol-level client test for discovery, valid calls, and rejected
  input.

## Listener contract

All operating systems implement:

- `onSession(active)` for coarse lifecycle;
- `onActivity("listening" | "speaking")`;
- `onLevel(0..1)` for lip movement; and
- `onStatus(...)` for diagnostics.

macOS additionally supports the internal `onPcm(frame)` callback when
`emitPcm` is explicitly enabled by an Avatar Driver. It is not a cross-platform
listener requirement and must never be forwarded through preload or a public
integration. Default VRM runs do not pass `--emit-pcm` to the helper.

`AudioActivityGate` owns the shared short-silence behavior. Lips follow every
level immediately. The body remains in its talking motion for 900 ms of silence
before returning to listening, preventing sentence gaps from causing abrupt
animation changes.

Voice-source validation and stable identities are shared through
`electron/voice-source.cjs`; discovery lives in
`electron/voice-source-discovery.cjs`. Settings supports automatic detection,
an exact application or PipeWire stream, an advanced regex, and external event
mode. `PERSONA_TARGET_PROCESS_PATTERN` overrides automatic and advanced
matching when set. Every source change recreates the listener immediately.

Linux persists a composite PipeWire stream identity so generic application
names such as `Electron` cannot collapse unrelated playback streams. macOS and
Windows persist executable identity and resolve the current process tree before
starting the native helper. PIDs and PipeWire object serials are never stored.

Linux implements the contract directly with PipeWire commands. macOS and
Windows helpers write newline-delimited JSON to stdout:

```json
{"type":"ready","source":"Windows process audio"}
{"type":"level","level":0.21}
```

The opt-in macOS PCM extension adds bounded `pcm` and `pcm-overflow` records.
PCM is mono `s16le` at the tap's native rate. The Core Audio callback writes to
a preallocated lock-free SPSC ring; JSON/base64 work happens on the helper's
non-real-time loop. Electron validates each record and hands it to a second
bounded queue that drops stale avatar frames under backpressure.

## Commands

```bash
npm run lint
npm test
npm run assets:check
npm run build
npm run native:build
npm run native:test
npm run test:liteavatar:e2e
npm run test:liteavatar:electron
npm run s4b:prepare
npm run test:s4b:electron
```

`npm run check` runs the platform-neutral checks together.

The native build command:

- does nothing on Linux because the runtime uses installed PipeWire commands;
- compiles Objective-C++ against Core Audio on macOS; and
- locates Visual Studio Build Tools and compiles C++ against WASAPI on Windows.

Linux packaging detects NixOS and runs `fpm` from `nixpkgs#fpm`, avoiding the
upstream bundled FPM wrapper's `/bin/bash` assumption. Other distributions use
electron-builder's bundled packaging tool.

## Test coverage

The Node suite covers settings persistence and imported-media boundaries, MCP
discovery and tool calls, the bridge boundary, URL protocol, Hyprland rules,
PipeWire selection and PCM normalization, process discovery on macOS and
Windows, native NDJSON parsing, shared pause smoothing, listener lifecycle,
Avatar Driver events and PCM backpressure, LiteAvatar runtime discovery,
resampling, JSON-lines isolation, frame validation, restart/fallback behavior,
asset safety, and release checksums.

Vitest covers animation priority and configured animation selection. GitHub
Actions then compiles and self-tests the native helper on its real operating
system and builds the renderer on all three platforms.

The two LiteAvatar E2E commands and the S4b Electron command are development-
machine gates, not CI tests. The first LiteAvatar gate runs the real model
against a WAV and enforces frame, latency, memory, swap, and queue budgets. The
second launches Electron and verifies the changing realistic frame surface.
The S4b gate decodes the one visible local surface, measures state and mouth
timing, and captures screenshots to reject blank transitions. It requires one
stable media URL and rectangle across speech, sends changing below-threshold
levels at approximately the real macOS meter cadence, rejects repeated seeks,
and verifies that resize/window-move gestures keep the hover frame interactive.

Debug dogfood runs persist their bounded lifecycle and five-second process
resource samples to `~/.persona/logs/persona-dogfood.log`. Raw PCM, video frames,
and settings payloads are not written there.

Headless CI cannot create a real Codex voice call or approve operating-system
audio permissions. Before a release, manually run the checklist in
[RELEASING.md](RELEASING.md) on each platform.

## Native API references

- Apple: [Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
- Microsoft: [Application loopback audio capture](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
