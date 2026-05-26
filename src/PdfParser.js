const path = require('path');
const url = require('url');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const PDFJS_BUILD_DIR = path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.js'));
const STANDARD_FONT_DATA_URL =
  url.pathToFileURL(path.join(PDFJS_BUILD_DIR, '..', '..', 'standard_fonts')).href + '/';

pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(PDFJS_BUILD_DIR, 'pdf.worker.js');

const MIN_PARAGRAPH_CHARS = 10;
const ROTATION_EPSILON = 0.05;
// Watermark tiles typically appear 50+ times per page; legitimate text
// like a place name in a KEY TO INITIALS table can appear 20–30 times.
const MAX_IDENTICAL_REPEATS_PER_PAGE = 50;
const PARAGRAPH_GAP_MULTIPLIER = 1.6;
const LINE_TOLERANCE_RATIO = 0.5;
const COLUMN_GAP_PT = 25;

const DIGITS_ONLY = /^\d{1,6}$/;
const PAGE_CODE = /^[A-Z]{1,4}\s*\d{1,4}$/;
const KEY_TO_INITIALS = /\bKEY\s+TO\s+INITIALS\b/i;
const HEADING_PATTERN = /\b(?:SCRIPTURES READ|READINGS?\s+(?:IN|AT)|PREACHING\s+(?:IN|AT)|MEETING\s+(?:IN|AT)|MINISTRY\s+(?:IN|AT)|ADDRESS\s+(?:IN|AT)|FELLOWSHIP\s+(?:IN|AT)|GOSPEL PREACHING|BIBLE READING)\b/;
const INTENTIONALLY_BLANK = /this is intentionally left blank\.?/gi;
// An initials "unit" is one capital letter, optionally Mc-prefixed, followed
// by EITHER a dot (standard) OR an em-dash-lowercase-dot tail (e.g. C—n.).
// A speaker prefix is 2–5 such units. This allows the dash-suffix to appear
// at ANY position, not just the last unit (D—n.J.H., G—h.M.S., K.R.C—n.).
const SPEAKER_PREFIX = /^((?:(?:Mc)?[A-Z](?:\s*\.|\s*[\p{Pd}−]+\s*[a-z]\s*\.?))(?:\s*(?:Mc)?[A-Z](?:\s*\.|\s*[\p{Pd}−]+\s*[a-z]\s*\.?)){1,4})\s+(.+)$/su;

function normalizeInitials(raw) {
  if (typeof raw !== 'string') return null;
  if (!raw.includes('.')) return null;
  const cleaned = raw.replace(/\s+/g, '').replace(/[\p{Pd}−]/gu, '-').toUpperCase();
  if (!/^[A-Z][A-Z.\-]*\.?$/.test(cleaned)) return null;
  const letters = cleaned.replace(/[^A-Z]/g, '');
  if (letters.length < 2 || letters.length > 8) return null;
  return cleaned;
}

function isRotated(transform) {
  if (!Array.isArray(transform) || transform.length < 4) return false;
  const [a, b, c, d] = transform;
  if (Math.abs(b) > ROTATION_EPSILON) return true;
  if (Math.abs(c) > ROTATION_EPSILON) return true;
  if (a < 0 || d < 0) return true;
  return false;
}

function filterItems(items) {
  const counts = new Map();
  for (const it of items) {
    const key = (it.str || '').trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return items.filter((it) => {
    const str = (it.str || '').trim();
    if (!str) return false;
    if (isRotated(it.transform)) return false;
    if (DIGITS_ONLY.test(str)) return false;
    if (PAGE_CODE.test(str)) return false;
    if ((counts.get(str) || 0) > MAX_IDENTICAL_REPEATS_PER_PAGE) return false;
    return true;
  });
}

function groupIntoLines(items) {
  const sorted = items
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      height: it.height || Math.abs(it.transform[3]) || 12,
      width: it.width || 0,
    }))
    .sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    const tolerance = (it.height || 12) * LINE_TOLERANCE_RATIO;
    if (last && Math.abs(last.y - it.y) <= tolerance) {
      last.parts.push(it);
      last.height = Math.max(last.height, it.height);
    } else {
      lines.push({ y: it.y, height: it.height, parts: [it] });
    }
  }

  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x);

    // Build the line text. pdf.js sometimes emits a line-break hyphen as its
    // own item at the right margin (separate from the word-fragment before it).
    // If the LAST part is a standalone "-" following a part that ends in a
    // letter, concatenate it without a space so the existing word-wrap
    // hyphen logic in joinLineContinuation can pick it up.
    let text = line.parts[0].str;
    for (let i = 1; i < line.parts.length; i++) {
      const part = line.parts[i];
      const isStandaloneTrailingHyphen =
        i === line.parts.length - 1 && part.str === '-' && /[a-zA-Z]$/.test(text);
      text += isStandaloneTrailingHyphen ? part.str : ' ' + part.str;
    }

    line.text = text.replace(/\s+/g, ' ').trim();
    line.firstX = line.parts[0].x;
  }

  return lines.filter((l) => l.text.length > 0);
}

function splitRowByColumnGaps(row) {
  const cells = [];
  let cur = [];
  let lastEnd = -Infinity;

  const flush = () => {
    if (cur.length > 0) {
      cells.push(cur.join(' '));
      cur = [];
    }
  };

  for (const part of row.parts) {
    const width = part.width || part.str.length * 5;
    if (cur.length > 0 && (part.x - lastEnd) > COLUMN_GAP_PT) flush();

    if (/\s{2,}/.test(part.str)) {
      const subCells = part.str.split(/\s{2,}/);
      for (let k = 0; k < subCells.length; k++) {
        const seg = subCells[k].trim();
        if (k > 0) flush();
        if (seg) cur.push(seg);
      }
    } else {
      cur.push(part.str);
    }
    lastEnd = part.x + width;
  }
  flush();

  return cells.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function looksLikeName(text) {
  if (!text || text.length > 40) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  for (const word of words) {
    if (/^[A-Z]/.test(word)) continue;
    if (/^(of|the|de|van|von|le|la|du|del|der|den)$/i.test(word)) continue;
    return false;
  }
  return true;
}

function parseTableRow(line) {
  const cells = splitRowByColumnGaps(line);
  if (cells.length === 0) return null;

  // Standard 3-cell row: [initials, name, place]
  if (cells.length >= 2) {
    const canonical = normalizeInitials(cells[0]);
    if (canonical && cells[1] && looksLikeName(cells[1])) {
      return { canonical, name: cells[1], place: cells[2] || '' };
    }
  }

  // Fallback: cells[0] holds "initials name" merged together.
  // Works for both the cells.length === 2 case ([initials+name, place])
  // and the cells.length === 1 case ([initials+name], no place column).
  const m = cells[0].match(SPEAKER_PREFIX);
  if (m && m[2]) {
    const canonical = normalizeInitials(m[1]);
    const name = m[2].trim();
    if (canonical && looksLikeName(name)) {
      return { canonical, name, place: cells.length >= 2 ? cells[1] : '' };
    }
  }

  return null;
}

const MAX_TABLE_SCAN = 200;

function extractSpeakers(allLines, verbose = false) {
  const speakers = new Map();
  const dropIndices = new Set();

  for (let i = 0; i < allLines.length; i++) {
    if (!KEY_TO_INITIALS.test(allLines[i].text)) continue;
    dropIndices.add(i);
    if (verbose) console.log(`[PdfParser] KEY TO INITIALS detected at line #${i}`);

    let j = i + 1;
    let nonRowStreak = 0;
    let scanned = 0;
    while (j < allLines.length && scanned < MAX_TABLE_SCAN) {
      const row = parseTableRow(allLines[j]);
      if (row) {
        speakers.set(row.canonical, { name: row.name, place: row.place });
        dropIndices.add(j);
        nonRowStreak = 0;
      } else {
        nonRowStreak++;
        if (verbose) {
          const cells = splitRowByColumnGaps(allLines[j]);
          console.log(
            `[PdfParser] table-scan rejected line #${j}: cells=${JSON.stringify(cells)} text="${allLines[j].text.slice(0, 100)}"`
          );
        }
        if (nonRowStreak >= 2) break;
      }
      j++;
      scanned++;
    }
    i = j - 1;
  }

  const lines = allLines.filter((_, idx) => !dropIndices.has(idx));
  return { speakers, lines };
}

function estimateBodyLeftXByPage(lines) {
  const byPage = new Map();
  for (const line of lines) {
    if (!byPage.has(line.pageNum)) byPage.set(line.pageNum, []);
    byPage.get(line.pageNum).push(line);
  }
  const map = new Map();
  for (const [page, pageLines] of byPage) {
    const xs = pageLines.map((l) => l.firstX).sort((a, b) => a - b);
    map.set(page, xs[Math.floor(xs.length * 0.2)] || 0);
  }
  return map;
}

// Join a continuation line onto the running paragraph text. If the previous
// text ends with a letter immediately followed by "-" (typical PDF line-break
// word-wrap hyphenation) AND the new line starts with a lowercase letter,
// strip the hyphen and concatenate without a space — so "consider-" + "ation"
// becomes "consideration", not "consider- ation".
function joinLineContinuation(current, newLineText) {
  if (!current) return newLineText;
  if (/[a-zA-Z]-$/.test(current) && /^[a-z]/.test(newLineText)) {
    return current.slice(0, -1) + newLineText;
  }
  return `${current} ${newLineText}`;
}

function stitchParagraphs(lines) {
  const bodyLeftByPage = estimateBodyLeftXByPage(lines);
  const paragraphs = [];
  let current = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : null;

    let newPara = !current;
    if (prev) {
      if (prev.pageNum !== line.pageNum) {
        newPara = /[.!?]['"”]?$/.test(current);
      } else {
        const gap = prev.y - line.y;
        const expected = Math.max(prev.height, line.height) * PARAGRAPH_GAP_MULTIPLIER;
        if (gap > expected) newPara = true;
        const bodyLeft = bodyLeftByPage.get(line.pageNum) || 0;
        if (line.firstX > bodyLeft + 6) newPara = true;
      }
    }

    if (newPara) {
      if (current.trim()) paragraphs.push(current.trim());
      current = line.text;
    } else {
      current = joinLineContinuation(current, line.text);
    }
  }
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs;
}

// Detect the document title by matching the structured 3-line block that
// these transcripts use, somewhere in the first few pages:
//   1. [TYPE OF MEETING] AT [PLACE]   (mostly uppercase, contains " AT ")
//   2. [Speaker]                       (initials + surname, e.g. "B.D. Hales")
//   3. [Date]                          (weekday, Month day, year)
// Returns { title, lastTitleLineIdx } where lastTitleLineIdx is the index
// within `allLines` of the LAST line of the title block, or null if no
// plausible title was found.
const TITLE_MEETING_RE = /^[A-Z][A-Z'’&.,\- ]*\s+AT\s+[A-Z][A-Z'’&.,\- ]+$/;
const TITLE_DATE_RE =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*\.?,?\s+[A-Z][a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}\b/i;
const TITLE_SPEAKER_RE =
  /^(?:(?:Mc)?[A-Z]\.\s*){1,5}(?:Mc)?[A-Z][a-z]+(?:[\s\-][A-Z][a-z]+)*\.?$/;

function detectTitle(allLines, opts = {}) {
  const maxPage = opts.maxPage || 4;

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (line.pageNum > maxPage) break;
    const text = line.text.trim();
    if (!TITLE_MEETING_RE.test(text)) continue;

    // Look at the next few lines on the same page for the date line.
    // The speaker line (if present and matching) sits between meeting and date.
    let dateIdx = -1;
    let speakerIdx = -1;
    const end = Math.min(allLines.length, i + 6);
    for (let j = i + 1; j < end; j++) {
      const next = allLines[j];
      if (next.pageNum !== line.pageNum) break;
      const t = next.text.trim();
      if (TITLE_DATE_RE.test(t)) {
        dateIdx = j;
        break;
      }
      if (speakerIdx === -1 && TITLE_SPEAKER_RE.test(t)) speakerIdx = j;
    }

    if (dateIdx < 0) continue;

    const parts = [line];
    if (speakerIdx > 0 && speakerIdx < dateIdx) parts.push(allLines[speakerIdx]);
    parts.push(allLines[dateIdx]);

    const title = parts
      .map((l) => l.text.trim())
      .filter(Boolean)
      .join(' — ');

    return { title, lastTitleLineIdx: dateIdx };
  }

  return { title: null, lastTitleLineIdx: -1 };
}

function trimBeforeHeading(paragraphs) {
  for (let i = 0; i < paragraphs.length; i++) {
    const m = paragraphs[i].match(HEADING_PATTERN);
    if (m) {
      const trimmed = paragraphs[i].substring(m.index);
      return [trimmed, ...paragraphs.slice(i + 1)];
    }
  }
  return paragraphs;
}

function stripBlankMarkers(paragraphs) {
  return paragraphs
    .map((p) => p.replace(INTENTIONALLY_BLANK, '').replace(/\s+/g, ' ').trim())
    .filter((p) => p.length >= MIN_PARAGRAPH_CHARS);
}

function attachSpeakers(paragraphs, speakers) {
  return paragraphs.map((text) => {
    const m = text.match(SPEAKER_PREFIX);
    if (!m) return { text };
    const canonical = normalizeInitials(m[1]);
    if (!canonical || !speakers.has(canonical)) return { text };
    const info = speakers.get(canonical);

    const rawPrefix = m[1].trim();
    const body = m[2].trim();
    const prefixHasInteriorSpaces = /\s/.test(rawPrefix);
    const tidiedPrefix = prefixHasInteriorSpaces ? rawPrefix.replace(/\s+/g, '') : rawPrefix;
    const displayText = prefixHasInteriorSpaces ? `${tidiedPrefix} ${body}` : text;

    return {
      text: displayText,
      alignText: body,
      speaker: { initials: canonical, name: info.name, place: info.place },
    };
  });
}

async function parse(filePath, opts = {}) {
  const verbose = opts.verbose === true;
  const doc = await pdfjsLib.getDocument({
    url: filePath,
    disableFontFace: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const allLines = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const items = filterItems(content.items);
    if (items.length === 0) continue;
    const lines = groupIntoLines(items).filter((line) => !PAGE_CODE.test(line.text));
    for (const line of lines) line.pageNum = pageNum;
    allLines.push(...lines);
  }

  const { title, lastTitleLineIdx } = detectTitle(allLines);
  if (title) {
    console.log(`[PdfParser] detected title: "${title}"`);
  }

  // Drop everything strictly before AND the title lines themselves, so the
  // preamble (T&Cs, copyright, etc.) and the title don't appear in the body —
  // the title is shown separately as a sticky banner in the renderer.
  const linesAfterTitle =
    lastTitleLineIdx >= 0 ? allLines.slice(lastTitleLineIdx + 1) : allLines;

  const { speakers, lines: contentLines } = extractSpeakers(linesAfterTitle, verbose);

  if (verbose) {
    console.log(`[PdfParser] detected ${speakers.size} speakers:`);
    for (const [key, info] of speakers) {
      console.log(`  ${key.padEnd(12)} -> ${info.name}  |  ${info.place}`);
    }
  }

  // Drop per-page "speaker reminder" footers — lines that parse as a row
  // for a speaker who is already in the aggregate KEY TO INITIALS map.
  let droppedFooters = 0;
  const cleanedLines = contentLines.filter((line) => {
    const row = parseTableRow(line);
    if (row && speakers.has(row.canonical)) {
      droppedFooters++;
      return false;
    }
    return true;
  });

  let paragraphs = stitchParagraphs(cleanedLines);
  paragraphs = trimBeforeHeading(paragraphs);
  paragraphs = stripBlankMarkers(paragraphs);

  const attached = attachSpeakers(paragraphs, speakers);
  // Always print a one-line summary. Detail comes from opts.verbose above.
  console.log(
    `[PdfParser] parsed ${attached.length} paragraphs, ${speakers.size} speakers, ${droppedFooters} footers dropped`
  );
  return { title, paragraphs: attached };
}

module.exports = { parse };
