// Lifted out of main.js so `node --test` can require it without pulling in
// Electron. Pure function, no side effects.

// Group each paragraph's sentences into alignment units of roughly one STT
// chunk's worth of words. Each unit remembers which paragraph and sentence
// range it covers so the renderer can highlight and scroll to sentences.
const MIN_UNIT_WORDS = 12;
const MAX_UNIT_WORDS = 40;

function buildUnits(paragraphs) {
  const units = [];
  paragraphs.forEach((p, para) => {
    const sentences =
      Array.isArray(p.sentences) && p.sentences.length > 0
        ? p.sentences
        : [p.alignText || p.text];
    let start = 0;
    let words = 0;
    let texts = [];
    const flush = (end) => {
      if (texts.length > 0) {
        units.push({ text: texts.join(' '), para, sentStart: start, sentEnd: end });
      }
    };
    for (let s = 0; s < sentences.length; s++) {
      const w = sentences[s].split(/\s+/).filter(Boolean).length;
      if (words > 0 && words + w > MAX_UNIT_WORDS) {
        flush(s - 1);
        start = s;
        words = 0;
        texts = [];
      }
      texts.push(sentences[s]);
      words += w;
      if (words >= MIN_UNIT_WORDS) {
        flush(s);
        start = s + 1;
        words = 0;
        texts = [];
      }
    }
    flush(sentences.length - 1);
  });
  return units;
}

module.exports = { buildUnits, MIN_UNIT_WORDS, MAX_UNIT_WORDS };
