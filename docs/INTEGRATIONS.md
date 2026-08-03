# Persona integrations

Persona's public integrations accept small state and level messages from local
voice experiences. The character renderer never receives raw audio,
transcripts, prompts, credentials, or host-application internals. An explicit
experimental Avatar Driver may consume process-local PCM inside the Electron
main process; it is not part of the renderer, preload, HTTP, or MCP contract.

The bundled Codex and ChatGPT integration uses native process-scoped output
listeners because those applications do not currently expose a supported
cross-process realtime voice event stream. If an official event stream becomes
available, it can map to the same contract without changing Persona's window or
animation system.

The output listener can switch to Talk when playback begins, but audio alone
cannot reveal when answer generation starts. A GPT Voice integration that owns
that lifecycle should send Persona's `thinking` event at generation start.

## Codex MCP server

Persona serves a Streamable HTTP MCP endpoint while the app is running. Add it
to Codex once:

```bash
codex mcp add persona --url http://127.0.0.1:47831/mcp
```

Start a new Codex session after registering the server. You can inspect the
saved connection with:

```bash
codex mcp get persona
```

Persona exposes these tools:

| Tool | Input | Effect |
| --- | --- | --- |
| `play_animation` | `animation`: a playable configured action name | Shows Persona and plays one randomly selected clip from that action |
| `list_animations` | None | Reads the latest playable action names, descriptions, and trigger scenarios |
| `control_window` | `action`: `show`, `hide`, or `toggle` | Controls the Persona window without quitting the app |
| `get_status` | None | Reads model readiness, window visibility, voice state, and listener status |

The animation descriptions are generated from Persona's playable actions.
Empty actions are omitted until a VRMA clip is added. User uploads, user edits
to packaged metadata, removals, and packaged-action resets are reflected
immediately through an MCP tool-list change notification. The
`play_animation` input remains open to valid action names and checks the live
library when invoked, so a client that does not refresh tool descriptions can
still run an action added during the current session. No media paths or
filesystem access are exposed.

With no configured model, window and animation commands remain inactive.
Persona can still report status while its Settings window is used for initial
setup.

An MCP-triggered action randomly selects one of its clips and temporarily takes
priority over voice-driven body motion. Lip sync continues while the clip
plays. A newer MCP action replaces the current one; when the one-shot clip
finishes, Persona returns to the current idle, listening, thinking, or speaking
state.

The MCP endpoint uses the same port as the local HTTP API. If
`PERSONA_BRIDGE_PORT` changes it, update the URL registered with Codex to match.

## Automatic listeners

Listeners attach to the configured voice source: automatic ChatGPT/Codex
detection, one selected application, or an advanced process pattern.

### Linux

Persona polls the PipeWire graph for either the selected playback stream or a
node matching the configured process pattern. It attaches `pw-record` to that
one stream, calculates RMS amplitude in memory, and discards every sample after
calculation. The stream remains connected to its normal output device.

### Windows

The native helper uses WASAPI application loopback with
`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`. Audio from other
applications is excluded. Persona supports Windows 10 build 20348 and newer.
Application mode resolves the saved executable identity to its current process
tree before starting the helper.

### macOS

The native helper creates a private, unmuted Core Audio process tap and private
aggregate device for the selected voice process. Persona supports macOS 14.2
and newer and declares why it requests System Audio Recording permission.
Application mode resolves the saved executable identity to its current process
tree before creating the tap.

The helper emits levels only unless the internal `realistic-pcm-spike` or
`liteavatar` Avatar Driver explicitly requests bounded PCM. That opt-in
extension does not change
tap timing: the tap is still created only after target output starts and is
released after output stops.

Set `PERSONA_TARGET_PROCESS_PATTERN` to a case-insensitive regular expression
to target another desktop voice application. This environment variable
overrides automatic and advanced-pattern matching, but not an explicitly
selected application or external mode:

```bash
PERSONA_TARGET_PROCESS_PATTERN='my-voice-app' persona
```

## Voice source settings

Open **Settings → Voice** to choose which application Persona watches for
automatic lip sync:

- **Automatic** keeps the built-in ChatGPT/Codex matcher.
- **Application** lists current playback streams on Linux and running
  applications on macOS and Windows, then persists a stable identity rather
  than a temporary PID or PipeWire serial.
- **Advanced** accepts a case-insensitive regular expression matched
  against process names and command lines on macOS and Windows, and against
  PipeWire application identity (plus process ancestry) on Linux.
- **External** disables automatic capture and waits for normalized state and
  level events through the loopback API.

By default Persona still calculates only an in-memory output level. The opt-in
macOS `realistic-pcm-spike` driver carries assistant-output PCM to an internal
bounded adapter seam, while `liteavatar` consumes that seam in an isolated
local model process and exposes only validated JPEG frames to the renderer.
Neither mode captures the microphone, transcribes speech, writes samples to
disk, exposes PCM to the renderer, or sends audio over the network. See
[Avatar Driver v1](AVATAR_DRIVER.md).

## Local models and voice pipelines

Persona is a visual companion for voice experiences. Local models such as Qwen
or GPT-OSS run in your own agent or inference stack; Persona animates beside
them. Three supported shapes:

1. **Process listen.** Point Settings → Voice at the desktop app that plays
   assistant audio (for example a local TTS player or voice UI). Persona
   attaches to that process the same way it attaches to ChatGPT or Codex.
2. **Loopback events.** Have your pipeline POST `thinking` when response
   generation starts, then `speaking` and normalized levels when playback
   begins. The native listener can detect playback and make the second switch
   automatically. URL integrations can open `persona://thinking` and
   `persona://speaking?level=…` instead.
3. **MCP actions.** Register any compatible MCP client against
   `http://127.0.0.1:47831/mcp` so the agent can trigger configured animations
   and window controls while audio still comes from (1) or (2).

## URL protocol

Installed packages register `persona://`.

| URL | Effect |
| --- | --- |
| `persona://show` | Show and focus Persona |
| `persona://hide` | Hide Persona without quitting |
| `persona://toggle` | Toggle visibility |
| `persona://listening` | Begin a listening state |
| `persona://thinking` | Begin the Thinking system action while a response is prepared |
| `persona://speaking?level=0.3` | Begin speaking and optionally set a level |
| `persona://inactive` | End the voice state without hiding Persona |
| `persona://animation?name=<animation-name>` | Play an active configured animation once |

Open these URLs with `xdg-open` on Linux, `open` on macOS, or `start` on
Windows.

## Loopback HTTP API

Persona listens on `127.0.0.1:47831` by default. Override the port with
`PERSONA_BRIDGE_PORT`. Native clients may omit `Origin`; browser clients are
restricted to trusted local and supported app origins. Requests with a
non-loopback `Host` are rejected.

Voice state:

```json
{
  "type": "state",
  "state": {
    "phase": "active",
    "activity": "thinking",
    "microphoneMuted": false,
    "outputMuted": false
  }
}
```

Allowed phases are `inactive`, `starting`, `active`, and `stopping`. Allowed
activities are `idle`, `listening`, `thinking`, and `speaking`.

Normalized level:

```json
{
  "type": "audio-level",
  "level": 0.31
}
```

Configured animation action:

```json
{
  "type": "animation",
  "animation_name": "example-animation"
}
```

The name must match a playable action in Persona's merged library.

Send events:

```bash
curl -H 'Content-Type: application/json' \
  --data '{"type":"state","state":{"phase":"active","activity":"thinking","microphoneMuted":false,"outputMuted":false}}' \
  http://127.0.0.1:47831/events
```

For GPT Voice, send that `thinking` event as soon as answer generation begins.
When Persona's process-scoped audio listener hears GPT Voice playback, it
automatically replaces Thinking with Speaking/Talk. Send `persona://inactive`
or an inactive HTTP state if generation is cancelled before playback.

`GET /health` reports whether Persona is running and returns the last state. It
does not expose user content.
