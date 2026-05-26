const { EventEmitter } = require('events');
const Fuse = require('fuse.js');

// Dynamic search-window sizing. The window is the slice of paragraphs ahead
// of `current` that Fuse is allowed to match against. Constraining it by
// elapsed time prevents the engine jumping far ahead when a short phrase
// happens to repeat later in the document.
//
// Approximate model: speech proceeds at roughly one paragraph per few seconds
// of audio, so the window scales linearly with elapsed time since the last
// successful match (capped both below and above).
const MIN_WINDOW = 3;                 // always allow at least this much lookahead
const MAX_WINDOW = 30;                // absolute hard cap on jump distance
const INITIAL_WINDOW = 10;            // window for the very first match (no prior timestamp)

class AlignmentEngine extends EventEmitter {
  constructor({ threshold = 0.35, paragraphsPerSecond = 1.0 } = {}) {
    super();
    this.threshold = threshold;
    this.paragraphsPerSecond = paragraphsPerSecond;
    this.paragraphs = [];
    this.current = 0;
    this.lastMatchAt = null;
  }

  setThreshold(t) {
    if (Number.isFinite(t)) this.threshold = t;
  }

  setParagraphsPerSecond(rate) {
    if (Number.isFinite(rate) && rate > 0) this.paragraphsPerSecond = rate;
  }

  setParagraphs(paragraphs) {
    this.paragraphs = paragraphs || [];
    this.current = 0;
    this.lastMatchAt = null;
    this.emit('position-update', { index: this.current, sttText: null, score: null });
  }

  resync(index) {
    if (!Number.isInteger(index)) return;
    const clamped = Math.max(0, Math.min(index, Math.max(0, this.paragraphs.length - 1)));
    this.current = clamped;
    this.lastMatchAt = Date.now();
    this.emit('position-update', { index: this.current, sttText: null, score: null });
  }

  _computeWindowSize(now) {
    if (this.lastMatchAt === null) return INITIAL_WINDOW;
    const elapsedSecs = (now - this.lastMatchAt) / 1000;
    const scaled = Math.ceil(MIN_WINDOW + elapsedSecs * this.paragraphsPerSecond);
    return Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, scaled));
  }

  match(sttText) {
    if (!sttText || this.paragraphs.length === 0) return;

    const now = Date.now();
    const windowSize = this._computeWindowSize(now);
    const end = Math.min(this.paragraphs.length, this.current + windowSize);
    const window = this.paragraphs.slice(this.current, end);
    if (window.length === 0) return;

    const fuse = new Fuse(window, {
      includeScore: true,
      threshold: this.threshold,
      ignoreLocation: true,
      minMatchCharLength: 4,
    });
    const results = fuse.search(sttText);
    if (results.length === 0) {
      this.emit('info', `no-match (window ${windowSize})`);
      this.emit('no-match', sttText);
      return;
    }

    const best = results[0];
    const nextIndex = this.current + best.refIndex;
    const jump = nextIndex - this.current;

    if (nextIndex > this.current) {
      this.emit(
        'info',
        `match +${jump} (window ${windowSize}, score ${best.score.toFixed(3)})`
      );
      this.current = nextIndex;
      this.lastMatchAt = now;
      this.emit('position-update', { index: this.current, sttText, score: best.score });
    } else {
      // Match at the current paragraph itself — refresh timer + send sttText for line-level targeting.
      this.lastMatchAt = now;
      this.emit('position-update', { index: this.current, sttText, score: best.score });
    }
  }
}

module.exports = { AlignmentEngine };
