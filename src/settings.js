// Pure settings helpers. No Electron imports — this module is required by
// main.js AND by test/units.test.js under plain `node --test`.
//
// Window expansion rate lives on two scales:
//
//   stored (user-facing)          engine (units/second)
//   windowExpansionRate  ──/10──▶  unitsPerSecond  ──×playbackRate──▶ setUnitsPerSecond()
//        1.0                           0.1                    0.1 @ 1.00x
//       10.0                           1.0                    1.25 @ 1.25x
//
// The /10 exists because the legacy key `alignmentParagraphsPerSecond` was
// tuned in a range (0.1–5.0) where the useful values clustered near the floor.
// Rescaling ×10 at the boundary puts the working value at 1 without touching
// AlignmentEngine, which still consumes plain units/second.

const EXPANSION_LEGACY_SCALE = 10;
const EXPANSION_MIN = 0.1;
const EXPANSION_MAX = 20;
const EXPANSION_DEFAULT = 1.0;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function numOrDefault(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Convert a persisted legacy `alignmentParagraphsPerSecond` into the new
// `windowExpansionRate` scale. Returns null when there is nothing to migrate
// (key absent, or not a finite number) — the caller then leaves the default in
// place. Absence is only a truthful signal because the legacy key was removed
// from the electron-store DEFAULTS object: `conf` merges AND persists defaults,
// so a defaulted key never reads back as undefined.
function migrateExpansionRate(legacy) {
  if (legacy === undefined || legacy === null || legacy === '') return null;
  const n = Number(legacy);
  if (!Number.isFinite(n)) return null;
  return clamp(n * EXPANSION_LEGACY_SCALE, EXPANSION_MIN, EXPANSION_MAX);
}

// What AlignmentEngine actually receives. playbackRate matters because
// _computeWindowSize scales on wall-clock elapsed time while the transcript
// advances at playback speed — see AlignmentEngine.js:75-80.
function effectiveUnitsPerSecond(windowExpansionRate, playbackRate) {
  const rate = clamp(numOrDefault(windowExpansionRate, EXPANSION_DEFAULT), EXPANSION_MIN, EXPANSION_MAX);
  const speed = numOrDefault(playbackRate, 1);
  const safeSpeed = speed > 0 ? speed : 1;
  return (rate / EXPANSION_LEGACY_SCALE) * safeSpeed;
}

module.exports = {
  EXPANSION_LEGACY_SCALE,
  EXPANSION_MIN,
  EXPANSION_MAX,
  EXPANSION_DEFAULT,
  clamp,
  numOrDefault,
  migrateExpansionRate,
  effectiveUnitsPerSecond,
};
