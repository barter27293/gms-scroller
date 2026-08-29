// Pure renderer helpers.
//
// Loaded as a PLAIN <script> (not type="module"): renderer/index.html is served
// over file:// via loadFile, and Chromium blocks ES modules from that origin.
// The `typeof module` guard at the bottom makes the same file require()-able
// from `node --test` without changing how the renderer consumes it.

/**
 * Seconds remaining -> display string.
 * Returns '' for anything not finite — a live stream reports duration as
 * Infinity, and "NaN left" is the bug this guards.
 */
function formatTime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return '';
  const total = Math.max(0, Math.round(n));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Clamped index step for the zoom and speed level arrays. */
function stepLevel(length, idx, delta) {
  const max = Math.max(0, length - 1);
  const next = Number(idx) + Number(delta);
  if (!Number.isFinite(next)) return 0;
  return Math.max(0, Math.min(max, Math.round(next)));
}

/** Parse a persisted level index, falling back when absent or out of range. */
function readLevelIndex(raw, length, fallback) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0 || n >= length) return fallback;
  return n;
}

/**
 * Rank candidate media elements and return the index of the one the transport
 * controls should target, or -1 when there are none.
 *
 * Descriptors: { paused, ended, active, currentTime, duration }.
 *
 * ORDER MATTERS. The audio site renders one <audio> per reading, each with
 * preload="metadata", so EVERY player reports a finite duration from page load
 * onward. "Has a finite duration" therefore identifies nothing and can only be
 * a last resort — making it the first rule silently pinned every control to
 * the first player on the page.
 *
 * This function is stringified into the webview by mediaExec(), so it must
 * stay self-contained: no closure variables, no imports.
 */
function pickMediaIndex(list) {
  if (!Array.isArray(list) || list.length === 0) return -1;

  const isPlaying = (m) => !m.paused && !m.ended;

  // 1. Playing AND most recently started. Nothing stops the page running two
  //    players at once, and then "first one playing" would be the stale one.
  let i = list.findIndex((m) => isPlaying(m) && m.active);
  if (i >= 0) return i;

  // 2. Playing right now.
  i = list.findIndex(isPlaying);
  if (i >= 0) return i;

  // 3. Most recently started. Set by the play-tracker mediaExec installs, so
  //    it holds even when the user starts or pauses from the site's own
  //    controls rather than our button.
  i = list.findIndex((m) => m.active);
  if (i >= 0) return i;

  // 4. Partially played — covers a first play that began before the tracker
  //    was installed.
  i = list.findIndex((m) => Number(m.currentTime) > 0);
  if (i >= 0) return i;

  // 5. Nothing has been touched yet: prefer one with real metadata.
  i = list.findIndex((m) => Number.isFinite(m.duration) && m.duration > 0);
  return i >= 0 ? i : 0;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatTime, stepLevel, readLevelIndex, pickMediaIndex };
}
