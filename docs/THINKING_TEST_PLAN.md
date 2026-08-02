# Thinking state test plan

## Goal

Verify that Persona enters the Thinking system action when answer generation
starts, changes to Talk when voice playback begins, and returns safely to Idle
when playback ends or generation is cancelled.

## Recommended test motion

Use `VRMA_06.vrma` (Model pose) from the local VRoid Project motion pack for
initial functional testing. It is the most semantically neutral option in that
pack. It lasts about 7.52 seconds and has little root-position discontinuity,
although a joint rotation difference at the loop boundary may still produce a
visible snap.

Do not ship this file inside Persona without satisfying its license and credit
requirements. For local testing, import it through **Settings → Actions →
Thinking → Add VRMA files**.

The final Thinking motion should be a purpose-built 4–8 second seamless loop:

- feet remain planted and root movement stays under roughly 3 cm;
- subtle breathing and weight transfer;
- a small head tilt or upward glance;
- optionally one hand near the chin, without covering the face;
- neutral expression so lip sync and facial expressions remain readable;
- identical or cross-fade-safe first and last poses.

For Frieren, prefer a restrained, slightly curious pose over an energetic or
comic gesture.

## Test layers and coverage targets

| Layer | Coverage target | Focus |
| --- | --- | --- |
| Unit | 100% of voice-to-animation branches | Thinking, Talk, muted output, inactive state, delayed Idle |
| Contract | Every accepted activity plus invalid input | URL protocol and loopback HTTP validation |
| Persistence | Every supported settings migration path | Permanent slot, uploaded clips, schema 5 custom `thinking` migration |
| Renderer integration | Complete lifecycle sequence | `thinking → speaking/Talk → idle` with no intermediate flash |
| Manual E2E | macOS plus one packaged build before release | GPT Voice timing, retargeting, loop quality, lip sync |

## Automated cases

1. `persona://thinking` produces an active state with activity `thinking`.
2. HTTP `/events` accepts `thinking` and rejects unknown activities.
3. Active Thinking resolves immediately to the `THINKING` animation, including
   when voice output is muted.
4. A following active `speaking` event replaces Thinking with `TALK`.
5. Inactive, stopped, or muted Speaking resolves to `IDLE`.
6. An empty Thinking slot is valid and leaves the model in its normal pose.
7. Multiple Thinking clips are selected without immediately repeating the same
   clip when alternatives exist.
8. A schema 5 custom action named `thinking` moves its clips into
   `system-thinking` without deleting the files or duplicating clip names.
9. Idle, Thinking, and Speaking system actions cannot be renamed or removed.
10. A one-shot command animation retains priority and returns to the current
    Thinking state when it completes.

## Manual end-to-end cases

| ID | Procedure | Expected result |
| --- | --- | --- |
| E1 | Open Settings → Actions | Idle, Thinking, and Speaking appear as permanent system actions |
| E2 | Add `VRMA_06.vrma` to Thinking and restart Persona | The clip remains installed and previews successfully |
| E3 | Send `persona://thinking` | Thinking starts within 500 ms; lips remain closed |
| E4 | Keep Thinking active for 60 seconds | The clip loops without drift, foot sliding, camera jumps, or accumulating pose error |
| E5 | Start GPT Voice playback while Thinking | Talk replaces Thinking on the first audible output, with no Idle flash |
| E6 | Insert a speech pause shorter than 900 ms | Persona remains in Talk |
| E7 | Stop playback | Talk releases after sustained silence and reaches Idle in about 1.55 seconds |
| E8 | Start Thinking, then send `persona://inactive` before audio | Persona returns directly to Idle |
| E9 | Trigger a configured one-shot action during Thinking | The action plays once, then the current Thinking loop resumes |
| E10 | Repeat the full lifecycle 10 times | No stuck state, duplicated animation action, memory growth, or renderer warning |
| E11 | Remove all Thinking clips and repeat E3–E8 | State transitions still work; the normal model pose is used instead of crashing |
| E12 | Test with Frieren at small and large window sizes | Hands, sleeves, hair, and staff/accessories do not clip distractingly |

## GPT Voice integration check

The generation owner must send Thinking before TTS playback:

```bash
curl -H 'Content-Type: application/json' \
  --data '{"type":"state","state":{"phase":"active","activity":"thinking","microphoneMuted":false,"outputMuted":false}}' \
  http://127.0.0.1:47831/events
```

Persona's process-scoped output listener should make the subsequent Talk switch
automatically. If generation fails or is cancelled before playback, the owner
must send an inactive state or open `persona://inactive`.

## Release gate

The feature is ready when all automated checks pass, E1–E12 pass without a
visible state flash, and a 60-second Thinking run has no objectionable loop
seam or character drift. A dedicated Thinking loop should replace
`VRMA_06.vrma` before treating visual quality as final.

## Current gaps

- Persona cannot infer response-generation start from output audio alone; the
  GPT Voice producer must emit the Thinking event.
- Motion aesthetics, cloth/hair collision, and loop seams still require visual
  review on the target VRM.
- The local VRoid Project pack contains no purpose-built thinking loop.

## Test run: 2026-08-02

Environment: macOS 15 arm64, local Frieren VRM, `VRMA_06.vrma` imported as
`thinking1`.

| Check | Result | Evidence |
| --- | --- | --- |
| Full repository check after Claude Code merge | Pass | 112 Node tests, 92 renderer tests, asset contract, audit, and production build |
| Native listener rebuild | Pass | macOS helper rebuilt after merging listener changes |
| Settings migration and import | Pass | Schema 5 migrated to 6; `thinking1` persisted under `system-thinking` |
| Frieren retargeting | Pass | 7.517-second clip, 53 tracks, 20 simulated seconds with finite transforms |
| Thinking event | Pass | HTTP accepted the event and `/health` reported active `thinking` |
| Thinking → Talk → Idle | Pass | Runtime captures showed both transitions without a T-pose flash |
| 7.52-second loop boundary | **Fail** | Pose changes abruptly from near-neutral to a pronounced hand-on-hip pose |
| Motion semantics | **Fail for final use** | Reads as a model pose or confident wait, not contemplation |

Functional status: ready. Visual status: `VRMA_06.vrma` is suitable only as a
temporary integration fixture. Prefer the empty-slot procedural fallback until
a dedicated seamless Thinking loop is available.
