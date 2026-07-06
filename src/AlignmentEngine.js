const { EventEmitter } = require('events');
const Fuse = require('fuse.js');

// The engine aligns STT text against "units" — sentence chunks of roughly
// 12–40 words, each mapping back to (paragraph index, sentence range). Units
// are comparable in length to one 8-second STT chunk, which keeps Fuse
// scoring meaningful and lets the transcript track position within large
// paragraphs instead of jumping a whole paragraph at a time.
//
// Dynamic search-window sizing: the window is the slice of units ahead of
// `current` that Fuse is allowed to match against, scaled linearly with the
// time since the last successful match (capped both below and above) so a
// short phrase repeating later in the document can't drag the position far
// ahead.
const MIN_WINDOW = 4; // always allow at least this much lookahead
const MAX_WINDOW = 40; // hard cap on forward jump distance in normal mode
const INITIAL_WINDOW = 15; // window for the very first match (no prior timestamp)

// Lost-sync recovery: after this many consecutive misses the engine widens
// the search — extra lookahead AND a little backward — until a match lands.
// Backward jumps are only ever allowed in recovery mode.
const RECOVERY_AFTER_MISSES = 3;
const RECOVERY_BACK = 10;
const RECOVERY_FORWARD_FACTOR = 2;

class AlignmentEngine extends EventEmitter {
  constructor({ threshold = 0.35, unitsPerSecond = 1.0 } = {}) {
    super();
    this.threshold = threshold;
    this.unitsPerSecond = unitsPerSecond;
    this.units = []; // [{ text, para, sentStart, sentEnd }]
    this.current = 0;
    this.lastMatchAt = null;
    this.consecutiveMisses = 0;
  }

  setThreshold(t) {
    if (Number.isFinite(t)) this.threshold = t;
  }

  setUnitsPerSecond(rate) {
    if (Number.isFinite(rate) && rate > 0) this.unitsPerSecond = rate;
  }

  setUnits(units) {
    this.units = Array.isArray(units) ? units : [];
    this.current = 0;
    this.lastMatchAt = null;
    this.consecutiveMisses = 0;
    this._emitPosition({ sttText: null, score: null, window: null });
  }

  resync(index) {
    if (!Number.isInteger(index)) return;
    const clamped = Math.max(0, Math.min(index, Math.max(0, this.units.length - 1)));
    this.current = clamped;
    this.lastMatchAt = Date.now();
    this.consecutiveMisses = 0;
    this._emitPosition({ sttText: null, score: null, window: null });
  }

  _emitPosition({ sttText, score, window }) {
    const unit = this.units[this.current] || null;
    this.emit('position-update', {
      index: this.current,
      para: unit ? unit.para : 0,
      sentStart: unit ? unit.sentStart : 0,
      sentEnd: unit ? unit.sentEnd : 0,
      sttText,
      score,
      window,
    });
  }

  _computeWindowSize(now) {
    if (this.lastMatchAt === null) return INITIAL_WINDOW;
    const elapsedSecs = (now - this.lastMatchAt) / 1000;
    const scaled = Math.ceil(MIN_WINDOW + elapsedSecs * this.unitsPerSecond);
    return Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, scaled));
  }

  match(sttText) {
    if (!sttText || this.units.length === 0) return;

    const now = Date.now();
    const recovery = this.consecutiveMisses >= RECOVERY_AFTER_MISSES;
    const windowSize = this._computeWindowSize(now);
    const from = recovery ? Math.max(0, this.current - RECOVERY_BACK) : this.current;
    const forward = recovery ? MAX_WINDOW * RECOVERY_FORWARD_FACTOR : windowSize;
    const to = Math.min(this.units.length, this.current + forward);
    const window = { from, to, recovery };
    const slice = this.units.slice(from, to);
    if (slice.length === 0) return;

    const fuse = new Fuse(
      slice.map((u) => u.text),
      {
        includeScore: true,
        threshold: this.threshold,
        ignoreLocation: true,
        minMatchCharLength: 4,
      }
    );
    const results = fuse.search(sttText);

    if (results.length === 0) {
      this.consecutiveMisses++;
      this.emit(
        'info',
        `no-match #${this.consecutiveMisses} (window ${from}–${to}${recovery ? ', recovery' : ''})`
      );
      this.emit('attempt', { matched: false, sttText, window });
      this.emit('no-match', sttText);
      return;
    }

    const best = results[0];
    const nextIndex = from + best.refIndex;
    const jump = nextIndex - this.current;
    this.consecutiveMisses = 0;

    if (nextIndex !== this.current && (nextIndex > this.current || recovery)) {
      this.emit(
        'info',
        `match ${jump >= 0 ? '+' : ''}${jump} (window ${from}–${to}${recovery ? ', recovery' : ''}, score ${best.score.toFixed(3)})`
      );
      this.current = nextIndex;
    }
    // A match at (or, outside recovery, behind) the current unit refreshes
    // the timer and still reports sttText for word-level scroll targeting.
    this.lastMatchAt = now;
    this.emit('attempt', {
      matched: true,
      index: this.current,
      score: best.score,
      sttText,
      window,
    });
    this._emitPosition({ sttText, score: best.score, window });
  }
}

module.exports = { AlignmentEngine };
