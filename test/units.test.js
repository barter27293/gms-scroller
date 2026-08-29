const test = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../src/settings');
const { buildUnits, MIN_UNIT_WORDS, MAX_UNIT_WORDS } = require('../src/buildUnits');
const { AlignmentEngine } = require('../src/AlignmentEngine');
const { formatTime, stepLevel, readLevelIndex, pickMediaIndex } = require('../renderer/helpers');

const words = (n) => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');
const para = (sentences) => ({ sentences });

// ============================================================
// settings - the migration that ships once, silently, on upgrade
// ============================================================

test('migrateExpansionRate: absent legacy key means no migration', () => {
  assert.equal(Settings.migrateExpansionRate(undefined), null);
  assert.equal(Settings.migrateExpansionRate(null), null);
  assert.equal(Settings.migrateExpansionRate(''), null);
});

test('migrateExpansionRate: the tuned 0.1 becomes exactly 1', () => {
  assert.equal(Settings.migrateExpansionRate(0.1), 1);
});

test('migrateExpansionRate: an untouched 1.0 preserves engine behaviour', () => {
  // 1.0 legacy == 1.0 units/sec. Migrated to 10, then /10 == 1.0 units/sec.
  const migrated = Settings.migrateExpansionRate(1.0);
  assert.equal(migrated, 10);
  assert.equal(Settings.effectiveUnitsPerSecond(migrated, 1), 1.0);
});

test('migrateExpansionRate: non-numeric legacy is not migrated', () => {
  assert.equal(Settings.migrateExpansionRate('abc'), null);
  assert.equal(Settings.migrateExpansionRate(NaN), null);
  assert.equal(Settings.migrateExpansionRate({}), null);
});

test('migrateExpansionRate: clamps beyond both bounds', () => {
  assert.equal(Settings.migrateExpansionRate(5), Settings.EXPANSION_MAX);
  assert.equal(Settings.migrateExpansionRate(0.0001), Settings.EXPANSION_MIN);
});

test('effectiveUnitsPerSecond: default scale puts the working value at 1', () => {
  assert.equal(Settings.effectiveUnitsPerSecond(1, 1), 0.1);
});

test('effectiveUnitsPerSecond: scales with playback rate', () => {
  assert.equal(Settings.effectiveUnitsPerSecond(1, 1.25), 0.125);
  assert.equal(Settings.effectiveUnitsPerSecond(10, 1.25), 1.25);
});

test('effectiveUnitsPerSecond: bad input falls back, never returns 0', () => {
  // AlignmentEngine.setUnitsPerSecond silently rejects <= 0, so a 0 here
  // would leave the search window frozen at whatever it already was.
  assert.ok(Settings.effectiveUnitsPerSecond(undefined, undefined) > 0);
  assert.ok(Settings.effectiveUnitsPerSecond('x', 'y') > 0);
  assert.ok(Settings.effectiveUnitsPerSecond(0, 0) > 0);
  assert.ok(Settings.effectiveUnitsPerSecond(-5, -5) > 0);
});

test('clamp and numOrDefault', () => {
  assert.equal(Settings.clamp(5, 0, 3), 3);
  assert.equal(Settings.clamp(-5, 0, 3), 0);
  assert.equal(Settings.numOrDefault('2.5', 9), 2.5);
  assert.equal(Settings.numOrDefault('nope', 9), 9);
});

// ============================================================
// buildUnits - units must stay comparable to one 8s STT chunk
// ============================================================

test('buildUnits: flushes once a unit reaches the minimum word count', () => {
  const units = buildUnits([para([words(MIN_UNIT_WORDS), words(MIN_UNIT_WORDS)])]);
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((u) => [u.sentStart, u.sentEnd]), [[0, 0], [1, 1]]);
});

test('buildUnits: short sentences accumulate rather than each becoming a unit', () => {
  const units = buildUnits([para([words(3), words(3), words(3), words(3), words(3)])]);
  assert.ok(units.length < 5, 'expected grouping, got ' + units.length + ' units');
});

test('buildUnits: does not overfill a unit past the max word budget', () => {
  const units = buildUnits([para([words(MAX_UNIT_WORDS), words(MAX_UNIT_WORDS)])]);
  assert.equal(units.length, 2);
});

test('buildUnits: falls back to alignText when sentences are absent', () => {
  const units = buildUnits([{ alignText: words(20), text: 'ignored' }]);
  assert.equal(units.length, 1);
  assert.equal(units[0].para, 0);
});

test('buildUnits: carries the paragraph index across multiple paragraphs', () => {
  const units = buildUnits([para([words(20)]), para([words(20)])]);
  assert.deepEqual(units.map((u) => u.para), [0, 1]);
});

test('buildUnits: empty input yields no units', () => {
  assert.deepEqual(buildUnits([]), []);
});

// ============================================================
// AlignmentEngine - the code that decides where the transcript scrolls
// ============================================================

const engineWith = (n, opts) => {
  const e = new AlignmentEngine(opts);
  e.setUnits(Array.from({ length: n }, (_, i) => ({
    text: 'unit ' + i, para: i, sentStart: 0, sentEnd: 0,
  })));
  return e;
};

test('AlignmentEngine: first match uses the initial window, not the elapsed scale', () => {
  const e = engineWith(100, { unitsPerSecond: 0.1 });
  assert.equal(e.lastMatchAt, null);
  assert.equal(e._computeWindowSize(Date.now()), 15);
});

test('AlignmentEngine: window grows with elapsed time and clamps at both ends', () => {
  const e = engineWith(100, { unitsPerSecond: 0.1 });
  const now = Date.now();
  e.lastMatchAt = now;
  assert.equal(e._computeWindowSize(now), 4, 'floor at MIN_WINDOW');
  assert.equal(e._computeWindowSize(now + 60 * 1000), 10, '4 + 60*0.1');
  assert.equal(e._computeWindowSize(now + 10 * 60 * 1000), 40, 'ceiling at MAX_WINDOW');
});

test('AlignmentEngine: a faster rate grows the window faster', () => {
  const now = Date.now();
  const slow = engineWith(100, { unitsPerSecond: 0.1 });
  const fast = engineWith(100, { unitsPerSecond: 0.125 });
  slow.lastMatchAt = now;
  fast.lastMatchAt = now;
  const t = now + 100 * 1000;
  assert.ok(fast._computeWindowSize(t) > slow._computeWindowSize(t));
});

test('AlignmentEngine: setUnitsPerSecond rejects zero and negatives', () => {
  const e = engineWith(10, { unitsPerSecond: 0.1 });
  e.setUnitsPerSecond(0);
  assert.equal(e.unitsPerSecond, 0.1);
  e.setUnitsPerSecond(-1);
  assert.equal(e.unitsPerSecond, 0.1);
  e.setUnitsPerSecond(0.5);
  assert.equal(e.unitsPerSecond, 0.5);
});

test('AlignmentEngine: matching advances forward and never rewinds', () => {
  const e = new AlignmentEngine({ threshold: 0.4, unitsPerSecond: 0.1 });
  e.setUnits([
    { text: 'the quick brown fox jumps over the lazy dog', para: 0, sentStart: 0, sentEnd: 0 },
    { text: 'pack my box with five dozen liquor jugs', para: 1, sentStart: 0, sentEnd: 0 },
    { text: 'how vexingly quick daft zebras jump about', para: 2, sentStart: 0, sentEnd: 0 },
  ]);
  e.match('pack my box with five dozen liquor jugs');
  const advanced = e.current;
  assert.ok(advanced > 0, 'expected forward advance, current=' + advanced);
  e.match('the quick brown fox jumps over the lazy dog');
  assert.ok(e.current >= advanced, 'position must not rewind on an earlier match');
});

test('AlignmentEngine: resync moves the position explicitly', () => {
  const e = engineWith(50, { unitsPerSecond: 0.1 });
  e.resync(20);
  assert.equal(e.current, 20);
});

// ============================================================
// renderer helpers
// ============================================================

test('formatTime: blank for non-finite durations (live streams report Infinity)', () => {
  assert.equal(formatTime(Infinity), '');
  assert.equal(formatTime(-Infinity), '');
  assert.equal(formatTime(NaN), '');
  assert.equal(formatTime(undefined), '');
  assert.equal(formatTime('abc'), '');
});

test('formatTime: under an hour uses M:SS', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(9), '0:09');
  assert.equal(formatTime(754), '12:34');
  assert.equal(formatTime(3599), '59:59');
});

test('formatTime: an hour or more uses H:MM:SS', () => {
  assert.equal(formatTime(3600), '1:00:00');
  assert.equal(formatTime(3723), '1:02:03');
});

test('formatTime: negative remainder clamps to zero, not a minus sign', () => {
  assert.equal(formatTime(-5), '0:00');
});

test('stepLevel: clamps at both ends', () => {
  assert.equal(stepLevel(6, 5, 1), 5);
  assert.equal(stepLevel(6, 0, -1), 0);
  assert.equal(stepLevel(6, 2, 1), 3);
  assert.equal(stepLevel(6, 2, -1), 1);
});

test('stepLevel: survives a garbage index', () => {
  assert.equal(stepLevel(6, NaN, 1), 0);
  assert.equal(stepLevel(0, 0, 1), 0);
});

test('readLevelIndex: falls back for absent, malformed or out-of-range values', () => {
  assert.equal(readLevelIndex(null, 6, 3), 3);
  assert.equal(readLevelIndex('abc', 6, 3), 3);
  assert.equal(readLevelIndex('-1', 6, 3), 3);
  assert.equal(readLevelIndex('6', 6, 3), 3);
  assert.equal(readLevelIndex('0', 6, 3), 0);
  assert.equal(readLevelIndex('5', 6, 3), 5);
});

// ============================================================
// pickMediaIndex - which <audio> the transport controls target
//
// The audio site renders one <audio> per reading (audioplayer1, audioplayer2),
// both with preload="metadata", so every player reports a finite duration from
// page load. Ranking on duration first pinned every control to player 1.
// ============================================================

const media = (o) => Object.assign(
  { paused: true, ended: false, active: false, currentTime: 0, duration: 3600 },
  o
);

test('pickMediaIndex: no media yields -1', () => {
  assert.equal(pickMediaIndex([]), -1);
  assert.equal(pickMediaIndex(null), -1);
  assert.equal(pickMediaIndex(undefined), -1);
});

test('pickMediaIndex: REGRESSION - two preloaded players, the second is playing', () => {
  // Both report duration 3600 because of preload="metadata". Ranking on
  // duration would return 0 here, which was the reported bug.
  const list = [media({}), media({ paused: false, active: true })];
  assert.equal(pickMediaIndex(list), 1);
});

test('pickMediaIndex: a playing element always beats an idle one', () => {
  assert.equal(pickMediaIndex([media({}), media({ paused: false })]), 1);
  assert.equal(pickMediaIndex([media({ paused: false }), media({})]), 0);
});

test('pickMediaIndex: with both playing, the most recently started wins', () => {
  const list = [media({ paused: false }), media({ paused: false, active: true })];
  assert.equal(pickMediaIndex(list), 1);
});

test('pickMediaIndex: after pausing player 2 from the site controls, it stays selected', () => {
  // Both paused. Player 1 was never touched; player 2 was played then paused,
  // so the play-tracker left data-gms-active on it. Resume must target it.
  const list = [media({}), media({ active: true, currentTime: 42 })];
  assert.equal(pickMediaIndex(list), 1);
});

test('pickMediaIndex: player 1 played to 30:00 then player 2 played and paused', () => {
  // currentTime alone would wrongly pick player 1 here; the active marker is
  // what makes "most recently used" beat "most progressed".
  const list = [media({ currentTime: 1800 }), media({ active: true, currentTime: 12 })];
  assert.equal(pickMediaIndex(list), 1);
});

test('pickMediaIndex: falls back to progress when no tracker marker exists', () => {
  // Covers a first play that began before mediaExec installed the tracker.
  const list = [media({}), media({ currentTime: 5 })];
  assert.equal(pickMediaIndex(list), 1);
});

test('pickMediaIndex: untouched page selects the first player with metadata', () => {
  assert.equal(pickMediaIndex([media({}), media({})]), 0);
  assert.equal(pickMediaIndex([media({ duration: NaN }), media({})]), 1);
});

test('pickMediaIndex: all unusable still returns a real index, never -1', () => {
  const list = [media({ duration: NaN }), media({ duration: NaN })];
  assert.equal(pickMediaIndex(list), 0);
});

test('pickMediaIndex: an ended player is not treated as playing', () => {
  const list = [media({ paused: false, ended: true }), media({ active: true, currentTime: 3 })];
  assert.equal(pickMediaIndex(list), 1);
});
