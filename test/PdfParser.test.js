const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPageFurnitureLine,
  isEndMatterLine,
  isTermsPage,
  dropRunningHeadersFooters,
} = require('../src/PdfParser')._internal;

// A line as groupIntoLines builds it: one part per pdf.js item.
const line = (strs, extra = {}) => ({
  parts: strs.map((str) => ({ str })),
  text: strs.join(' '),
  ...extra,
});
const PAGE_HEIGHT = 433.7;
const at = (text, pageNum, y) => ({ text, pageNum, y, pageHeight: PAGE_HEIGHT });

// ============================================================
// isPageFurnitureLine - page numbers merged with book codes
// ============================================================

test('isPageFurnitureLine drops footers made of page codes and numbers', () => {
  assert.equal(isPageFurnitureLine(line(['WB 1039', '30'])), true);
  assert.equal(isPageFurnitureLine(line(['29', 'WB 1039'])), true);
  assert.equal(isPageFurnitureLine(line(['30'])), true);
  assert.equal(isPageFurnitureLine(line(['WB 1039'])), true);
});

test('isPageFurnitureLine keeps lines with real words', () => {
  assert.equal(isPageFurnitureLine(line(['1 John 4'])), false);
  assert.equal(isPageFurnitureLine(line(['Luke 7'])), false);
  assert.equal(isPageFurnitureLine(line(['there are others', '30'])), false);
});

// ============================================================
// isEndMatterLine - "Extracted from…" note and bare closing date
// ============================================================

test('isEndMatterLine drops the extract note and a bare date', () => {
  assert.equal(isEndMatterLine(line(['Extracted from BDH White Book 1039'])), true);
  assert.equal(isEndMatterLine(line(['Extract from BDH White Book 1039'])), true);
  assert.equal(isEndMatterLine(line(['August 30, 2026'])), true);
  assert.equal(isEndMatterLine(line(['30 August 2026'])), true);
});

test('isEndMatterLine keeps body text and the title date', () => {
  assert.equal(isEndMatterLine(line(['on August 30 we came to the meeting'])), false);
  assert.equal(isEndMatterLine(line(['Lord’s day, August 30, 2026'])), false);
  assert.equal(isEndMatterLine(line(['extracted from the world, you see'])), false);
});

// ============================================================
// isTermsPage - the copyright / T&Cs page
// ============================================================

test('isTermsPage recognises the T&Cs page', () => {
  const page = [
    'Copyright © Bible and Gospel Trust and/or Ministry Holdings Pty Ltd 2026.',
    'All rights reserved.',
    'This publication has been designated by the trustees of Bible',
  ].map((t) => line([t]));
  assert.equal(isTermsPage(page), true);
});

test('isTermsPage keeps a body page that mentions one marker', () => {
  const page = [
    'We were thinking of the Bible and Gospel Trust and the',
    'service rendered, beloved.',
  ].map((t) => line([t]));
  assert.equal(isTermsPage(page), false);
});

test('isTermsPage keeps a page that also holds a heading', () => {
  const page = [
    'PREACHING AT SYDNEY',
    'Copyright © Bible and Gospel Trust and/or Ministry Holdings Pty Ltd 2026.',
    'All rights reserved.',
  ].map((t) => line([t]));
  assert.equal(isTermsPage(page), false);
});

// ============================================================
// dropRunningHeadersFooters - text repeated in the margin band
// ============================================================

test('dropRunningHeadersFooters removes a footer repeated on most pages', () => {
  const lines = [];
  for (let p = 1; p <= 5; p++) {
    lines.push(at(`body text unique to page ${p}`, p, 200));
    // Mirrored odd/even layout: order of code and number swaps.
    lines.push(at(p % 2 ? `${p + 28} Vol. 12` : `Vol. 12 ${p + 28}`, p, 13.6));
  }
  const { lines: kept, dropped } = dropRunningHeadersFooters(lines);
  assert.equal(dropped, 5);
  assert.deepEqual(kept.map((l) => l.pageNum), [1, 2, 3, 4, 5]);
  assert.ok(kept.every((l) => l.text.startsWith('body text')));
});

test('dropRunningHeadersFooters keeps differing margin lines and mid-page repeats', () => {
  const lastLines = ['every one of us', 'build-up there', 'the cross, see', 'His name', 'beloved, and'];
  const lines = [];
  lastLines.forEach((text, i) => {
    lines.push(at(text, i + 1, 26.3));
    lines.push(at('And he said, Amen.', i + 1, 200));
  });
  const { lines: kept, dropped } = dropRunningHeadersFooters(lines);
  assert.equal(dropped, 0);
  assert.equal(kept.length, 10);
});
