# S4b pre-rendered state avatar

S4b is Persona's lightweight realistic renderer. Its pack contract retains
four local clip slots (`idle`, `listening`, `thinking`, and `speaking`), but the
current renderer deliberately keeps the speaking clip as one continuous visual
surface. The authored neutral frame stays above that same paused video outside
speech, with a subtle ambient transform for non-speaking motion. Voice-state
changes therefore never replace the full person with a differently framed
video. A missing or undecodable pack leaves the configured VRM visible.

S4b never requests raw PCM. It receives the same bounded `state` and
`audio-level` events as VRM. State remains available for UI and diagnostics;
audio level starts the already-visible speaking video immediately. After a
short silence hold, Persona pauses it and cross-fades its own predecoded
closed-mouth frame above it. The visible source and its rectangle never change,
and the incoming level stream never repeatedly seeks it. S4b is intentionally
a responsive visual illusion, not phoneme-level lip synchronization.

## Development pack and manual run

The local preparation command adapts the already downloaded LiteAvatar sample.
It copies no avatar media into this repository or Persona's release bundle. The
result stays under `~/.persona/avatar-packs/s4b-default/`, carries the upstream
license beside it, and is reused on later runs.

```bash
npm run s4b:prepare
npm run test:s4b:electron
npm run dogfood:s4b
```

Preparation starts LiteAvatar once to render a generic speaking loop, preserves
the source speech duration, closes the loop with neutral frames, and transcodes
all four clips to H.264. Generator v2 produces 176 frames / 5.867 seconds from
the current 5.547-second source instead of compressing it into five seconds.
Normal S4b startup does not load Python, ONNX, Torch, or Metal models.
Set `PERSONA_S4B_PACK=/absolute/path/to/pack` to use a different pack. Set
`PERSONA_LITEAVATAR_RUNTIME` when preparing from a runtime outside the default
development location.

The generated sample is for local evaluation only. Its source video has an
opaque pale background, so the generated sample remains opaque. S4b itself
accepts video with embedded alpha; a transparent character requires alpha to
be created during the offline asset pipeline rather than guessed from the
finished white-background clip.

## Pack contract

Each directory contains `s4b.json` and four local clip entries. Paths must be
relative, remain inside the pack after symlink resolution, and use `.mp4`,
`.m4v`, `.mov`, or `.webm`. Schema v1 still validates all four entries for pack
compatibility; the current coherent-surface renderer visibly decodes only the
speaking entry.

```json
{
  "schema_version": 1,
  "id": "studio-assistant",
  "name": "Studio Assistant",
  "width": 890,
  "height": 1920,
  "background": "alpha",
  "cross_fade_ms": 110,
  "mouth_gate": {
    "open_threshold": 0.018,
    "close_delay_ms": 320
  },
  "states": {
    "idle": { "file": "idle.webm", "playback_rate": 1 },
    "listening": { "file": "listening.webm", "playback_rate": 1 },
    "thinking": { "file": "thinking.webm", "playback_rate": 1 },
    "speaking": {
      "file": "speaking.webm",
      "playback_rate": 1,
      "start_offset_ms": 0
    }
  }
}
```

`background` records authoring intent; transparency still comes from the
video's alpha channel. `playback_rate` is clamped to 0.25–4.0,
`start_offset_ms` to ten minutes, cross-fade to 0–500 ms, and mouth-close delay
to 320–500 ms. Once open, the mouth uses a lower close threshold (at most
0.008) so quiet syllables refresh the 320 ms peak-hold envelope without needing
to cross the higher opening threshold again.

## Creating a new person

The speaking clip must keep one identity, camera, crop, resolution, and
lighting throughout, and must begin with a closed mouth because Persona
predecodes that frame as its non-speaking surface. Use five to ten seconds and
make the first and last frames match closely. Schema v1 also requires the three
non-speaking entries; they may share a neutral local clip, but are not visibly
swapped by the current renderer. Audio level gates playback but never changes
the authored playback speed.

For a transparent desktop character, render straight to an alpha-capable
format. VP9 WebM with alpha is the most portable Chromium target. HEVC with
alpha can be useful on Apple platforms but must be verified in the exact
Electron build before choosing it. Do not use color-key removal when the
person's clothes share the background color.

Place the clips and manifest in a new directory, then validate by launching:

```bash
PERSONA_AVATAR_DRIVER=s4b \
PERSONA_S4B_PACK=/absolute/path/to/pack \
PERSONA_DEBUG=1 npm start
```

Keep the source model, generation prompt/settings, and media license beside the
pack. A local pack is not automatically eligible for redistribution.

`npm run dogfood:s4b` writes timestamped listener, renderer-event, and
five-second CPU/memory samples to
`~/.persona/logs/persona-dogfood.log`. The file rotates after 5 MB and contains
no PCM or video frames. This makes the next dogfood run diagnosable after the
terminal has closed.

## Measured development gate

The real Electron gate launches the production renderer, decodes the speaking
clip through the locked `persona-s4b:` protocol, changes state through the
loopback event API, opens and closes the speaking loop, and captures 30
screenshots. It requires the same media URL and exact surface rectangle before
and after speech, then simulates a held resize plus window movement to ensure
the macOS frame cannot turn click-through mid-gesture.

| Check | 2026-08-02 result |
| --- | ---: |
| Electron launch to painted S4b | 579–839 ms |
| Closed-mouth frame decoded | 579–839 ms |
| Listening state update | 7–10 ms |
| Thinking state update | 2–3 ms |
| Direct level event to mouth playback | 2–3 ms |
| Silence to closed mouth | 144–152 ms |
| Visible sources before/after speech | 1, identical URL and rectangle |
| 30 Hz-style low-level samples | 12/12 nonblank, 0 video seeks |
| Transition screenshot samples | 30/30 nonblank |
| Smallest transition screenshot | 238,026 bytes |
| macOS resize/move interaction latch | passed |

These switch and mouth numbers use direct loopback events. With ChatGPT desktop
audio capture, the first response also includes the native helper's output
detection and tap-attachment time. S4b removes model inference delay, but it
cannot make a passive observer know about audio before that audio starts.

## Latest manual dogfood verdict

The 2026-08-02 manual run accepted the single-surface visual fix: speech no
longer flashed and the person's size no longer jumped. It did **not** accept the
overall S4b gate:

- Moving the pointer from the person into the macOS frame chrome makes the
  frame disappear before pointer-down. Move and resize therefore remain
  untested, not passed.
- During some continuous Voice output the speaking video pauses and the neutral
  frame covers it, even though audio is still audible. The video element is
  configured to loop, so the current evidence points to a false mouth-gate
  close rather than end-of-media playback.

The existing frame automation starts after a resize pointer-down or after the
BrowserWindow has begun moving. It cannot prove the earlier person-to-app-region
handoff that failed manually. The next macOS implementation moves frame hit
testing into the main process using screen coordinates, with an explicit
“Adjust position and size” mode as a fallback.

Mouth continuity had a similar evidence gap. Voice activity holds speaking
across roughly 900 ms of low level, while the pack used in that failed run
closed after 140 ms. Debug logs only sampled levels above 0.025, so they omitted the low samples that
can trigger this close. The next gate adds reasoned mouth-transition telemetry,
then tests a lower close threshold plus a 280–350 ms envelope. It must bridge
80–240 ms low-level gaps, close within 350–500 ms of sustained silence, and
continue across the speaking clip's loop boundary.

Do not request another manual dogfood pass until both the frame-handoff and
mouth-continuity gates pass automatically. The Google Flow asset pilot then
produces one anchor, one speaking video, and one locally generated neutral
compatibility clip; it does not restore full-frame switching among four videos.

## P0 automated remediation

Both prerequisites passed on 2026-08-02 and S4b is ready for the next manual
dogfood pass:

- The main process now owns a visible frame lease using
  `screen.getCursorScreenPoint()` plus BrowserWindow bounds. Renderer
  `mouseout/blur` cannot release it; the real cursor must remain outside the
  frame for 220 ms. A tray “Adjust position and size” mode pins the frame and
  whole-window interaction until toggled off or Escape is pressed.
- The mouth gate now opens at the authored threshold, stays active above a
  lower close threshold, and closes after a minimum 320 ms envelope. Every
  open/close transition records reason, level, Voice activity, playback state,
  and media time in the bounded dogfood log.

Three real Electron gates passed. They bridged 80, 160, and 240 ms
low-level gaps without pausing, continued across the speaking video loop
boundary, and closed after 326–332 ms of sustained silence. The synthetic
pre-pointer `mouseout/blur`, held resize, BrowserWindow move, and explicit
adjustment-mode checks all retained the frame. This is stronger automation than
the previous post-pointerdown-only gate, but native top-bar feel still needs
human confirmation.
