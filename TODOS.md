# TODOS

Deferred work, captured from `/plan-eng-review` on 2026-08-29 (v0.5.0 planning).
Each entry carries enough context to pick up cold.

---

## Playwright Electron E2E harness

**What:** End-to-end coverage for the auto-listen state machine, the transport
controls, playback speed and time remaining.

**Why:** `npm test` covers the alignment engine, unit building, the settings
migration and the renderer helpers — but every *user flow* is untested. The
coverage audit found five: transcript loaded while audio is already playing;
audio started after the transcript loads; pause from the site's own player;
speed change mid-playback; and the FFmpeg-not-capturing failure path.

**Pros:** Catches the toolbar/title-bar layout regressions that the `els`
cache makes easy to introduce — one missed rename silently kills the renderer.

**Cons:** FFmpeg loopback and faster-whisper cannot run in CI, so the listening
half stays mocked. The tests would prove the UI reacted, not that transcription
worked.

**Start:** `@playwright/test` with `_electron.launch()`, plus a local fixture
HTML page carrying an `<audio>` element to stand in for the site.

**Depends on:** nothing, but wait until the UI stops moving.

---

## Scale `chunkSeconds` with `playbackRate`

**What:** Shrink the 8-second capture chunk proportionally at higher speed
(`8 / playbackRate`) so each chunk keeps carrying roughly one alignment unit's
worth of words.

**Why:** v0.5.0 scales the window expansion rate and the scroll drift by
`playbackRate`, but not the chunk itself. `src/AlignmentEngine.js:4-6` states
units are sized to match one 8-second STT chunk; at 1.25x a chunk holds ~25%
more words than a unit, so Fuse compares mismatched lengths.

**Pros:** Closes the last piece of the speed/alignment coupling.

**Cons:** `chunkBytes` is fixed in the `AudioCapture` constructor
(`src/AudioCapture.js:86`), so changing it means rebuilding the capture object —
which v0.5.0 deliberately removed from the pause path to stop pipeline churn.

**Start:** Make `chunkBytes` a setter that resizes the buffer without
respawning FFmpeg.

**Depends on:** the existing `playbackRate` scaling, so the residual mismatch
can be measured first. It may turn out not to be noticeable.

---

## Deduplicate the two dialog CSS blocks

**What:** Factor the shared styling out of `#settings-dialog` and
`#update-dialog` in `renderer/styles.css`.

**Why:** Roughly 120 near-identical lines — `min-width`, `max-height`,
`::backdrop`, the `fieldset`/`legend`/`.hint` conventions and `.dialog-actions`
are duplicated wholesale. v0.5.0 added three controls to the settings dialog,
so the duplication is actively being exercised.

**Pros:** Pure refactor, no behaviour change.

**Cons:** Touches CSS both dialogs depend on, so it wants a visual check of
each.

**Start:** A shared `.app-dialog` class applied to both `<dialog>` elements.

**Depends on:** nothing — deliberately kept out of v0.5.0 so any layout
regression there has one obvious cause.
