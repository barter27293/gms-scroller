const els = {
  stopBtn: document.getElementById('btn-stop'),
  settingsBtn: document.getElementById('btn-settings'),
  fullscreenBtn: document.getElementById('btn-fullscreen'),
  fullscreenExitBtn: document.getElementById('btn-fullscreen-exit'),
  zoomInBtn: document.getElementById('btn-zoom-in'),
  zoomOutBtn: document.getElementById('btn-zoom-out'),
  zoomLevel: document.getElementById('zoom-level'),
  speedDownBtn: document.getElementById('btn-speed-down'),
  speedUpBtn: document.getElementById('btn-speed-up'),
  speedLevel: document.getElementById('speed-level'),
  timeRemaining: document.getElementById('time-remaining'),
  tabs: document.querySelectorAll('#tabs .tab'),
  tabPanels: {
    transcript: document.getElementById('tab-transcript'),
    browser: document.getElementById('tab-browser'),
  },
  status: document.getElementById('status'),
  transcript: document.getElementById('transcript'),
  transcriptTitleText: document.getElementById('transcript-title-text'),
  transcriptEmpty: document.getElementById('transcript-empty'),
  documentPage: document.getElementById('document-page'),
  scrollArea: document.getElementById('scroll-area'),
  webview: document.getElementById('audioSite'),

  settingsDialog: document.getElementById('settings-dialog'),
  settingsUsername: document.getElementById('settings-username'),
  settingsPassword: document.getElementById('settings-password'),
  settingsAutosubmit: document.getElementById('settings-autosubmit'),
  settingsWhisperModel: document.getElementById('settings-whisper-model'),
  settingsShowMatch: document.getElementById('settings-show-match'),
  settingsFuseThreshold: document.getElementById('settings-fuse-threshold'),
  settingsExpansionRate: document.getElementById('settings-expansion-rate'),
  settingsShowDiagnostics: document.getElementById('settings-show-diagnostics'),
  settingsVersion: document.getElementById('settings-version'),
  settingsScrollGain: document.getElementById('settings-scroll-gain'),
  settingsScrollBaseline: document.getElementById('settings-scroll-baseline'),
  settingsScrollMax: document.getElementById('settings-scroll-max'),
  settingsVerboseLogging: document.getElementById('settings-verbose-logging'),
  settingsSaveBtn: document.getElementById('settings-save'),
  settingsCancelBtn: document.getElementById('settings-cancel'),
  settingsClearBtn: document.getElementById('settings-clear'),

  diagPanel: document.getElementById('diag-panel'),
  diagStatus: document.getElementById('diag-status'),
  diagParagraphs: document.getElementById('diag-paragraphs'),
  diagClose: document.getElementById('diag-close'),
  diagAudioDevice: document.getElementById('diag-audio-device'),
  diagFfmpeg: document.getElementById('diag-ffmpeg'),
  diagPython: document.getElementById('diag-python'),
  diagWhisper: document.getElementById('diag-whisper'),
  diagChunks: document.getElementById('diag-chunks'),
  diagTranscriptions: document.getElementById('diag-transcriptions'),
  diagLastText: document.getElementById('diag-last-text'),
  diagLastMatch: document.getElementById('diag-last-match'),
  diagLogPath: document.getElementById('diag-log-path'),
  diagLog: document.getElementById('diag-log'),

  updateDialog: document.getElementById('update-dialog'),
  updateTitle: document.getElementById('update-title'),
  updateSubtitle: document.getElementById('update-subtitle'),
  updateNotes: document.getElementById('update-notes'),
  updateProgressWrap: document.getElementById('update-progress-wrap'),
  updateProgressFill: document.getElementById('update-progress-fill'),
  updateProgressLabel: document.getElementById('update-progress-label'),
  updateLaterBtn: document.getElementById('update-later'),
  updateActionBtn: document.getElementById('update-action'),
};

const state = {
  paragraphNodes: [],
  sentenceNodes: [], // [para][sent] -> span element
  sentMeta: [], // [para][sent] -> { start, end } char offsets in body textContent
  sentToUnit: [], // [para][sent] -> alignment unit index
  units: [], // [{ para, sentStart, sentEnd }]
  activeUnit: -1,
  windowUnits: [], // unit indices currently marked .in-window
  lastMatchRange: null, // DOM Range of the last matched word run
  showMatchDetails: true,
  autoScrollResumeDelay: 3000,
  isListening: false,
  activeTab: 'transcript',
  hasTranscript: false,
  mediaPlaying: false,
};

// ---- Scroll controller defaults (overridable per-instance from config) ----
const SCROLL_GAIN_DEFAULT = 0.35;
const SCROLL_MAX_V_DEFAULT = 90;
const SCROLL_BASELINE_V_DEFAULT = 3;
const SCROLL_DEAD_ZONE = 40; // px from target before we taper toward baseline

// ---- Zoom levels ----
const ZOOM_LEVELS = [0.75, 0.85, 0.95, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0];
let zoomIdx = ZOOM_LEVELS.indexOf(1.0);

// ---- Playback speed (up to +25%) ----
const SPEED_LEVELS = [1.0, 1.05, 1.1, 1.15, 1.2, 1.25];
let speedIdx = 0;

// ---- Time-remaining / playbackRate poll ----
const MEDIA_POLL_MS = 1000;
let mediaPollTimer = null;

let scrollController = null;
// Unscaled config value; applySpeed() multiplies it by the playback rate.
let baseBaselineVelocity = SCROLL_BASELINE_V_DEFAULT;

// ============================================================
// Scroll controller
// ============================================================

class ScrollController {
  constructor(pane, opts = {}) {
    this.pane = pane;
    this.target = null;
    this.userPausedUntil = 0;
    this.running = false;
    this.lastTick = 0;
    this.scrollPos = pane.scrollTop || 0;
    this.gain = opts.gain ?? SCROLL_GAIN_DEFAULT;
    this.maxVelocity = opts.maxVelocity ?? SCROLL_MAX_V_DEFAULT;
    this.baselineVelocity = opts.baselineVelocity ?? SCROLL_BASELINE_V_DEFAULT;
    this._tick = this._tick.bind(this);
  }

  updateTuning(opts = {}) {
    if (Number.isFinite(opts.gain)) this.gain = opts.gain;
    if (Number.isFinite(opts.maxVelocity)) this.maxVelocity = opts.maxVelocity;
    if (Number.isFinite(opts.baselineVelocity)) this.baselineVelocity = opts.baselineVelocity;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTick = performance.now();
    this.scrollPos = this.pane.scrollTop;
    requestAnimationFrame(this._tick);
  }

  stop() { this.running = false; }

  setTarget(absY) { this.target = absY; }

  jumpToTarget() {
    if (this.target === null) return;
    const newPos = Math.max(0, this.target - this.pane.clientHeight / 2);
    this.scrollPos = newPos;
    this.pane.scrollTop = newPos;
  }

  pauseForUserScroll(ms) {
    this.userPausedUntil = Date.now() + (ms || state.autoScrollResumeDelay);
  }

  pauseIndefinitely() {
    this.target = null;
    this.userPausedUntil = Number.POSITIVE_INFINITY;
  }

  resume() {
    this.userPausedUntil = 0;
    this.scrollPos = this.pane.scrollTop;
  }

  _tick(now) {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.lastTick) / 1000);
    this.lastTick = now;

    if (Date.now() < this.userPausedUntil) {
      this.scrollPos = this.pane.scrollTop;
    } else if (this.target !== null) {
      const paneCenter = this.scrollPos + this.pane.clientHeight / 2;
      const error = this.target - paneCenter;

      // Chase the target while ahead; once caught up, drift gently forward
      // at baselineVelocity so the page never sits frozen between matches.
      // Reaching the document end is handled by the scrollPos clamp below.
      let velocity;
      if (error > SCROLL_DEAD_ZONE) {
        velocity = Math.min(this.maxVelocity, error * this.gain);
      } else if (error > 0) {
        // Blend between baseline (at error→0) and the chase rate (at edge of dead zone).
        const chase = Math.min(this.maxVelocity, error * this.gain);
        const t = error / SCROLL_DEAD_ZONE;
        velocity = this.baselineVelocity + t * (chase - this.baselineVelocity);
      } else {
        velocity = this.baselineVelocity;
      }

      if (velocity > 0) {
        this.scrollPos += velocity * dt;
        const maxScroll = Math.max(0, this.pane.scrollHeight - this.pane.clientHeight);
        if (this.scrollPos < 0) this.scrollPos = 0;
        if (this.scrollPos > maxScroll) this.scrollPos = maxScroll;
        this.pane.scrollTop = this.scrollPos;
      }
    }

    requestAnimationFrame(this._tick);
  }
}

// ============================================================
// Line targeting within a paragraph (word-LCS + Range API)
// ============================================================

function tokenize(text) {
  return text.replace(/[^\w\s']/g, ' ').split(/\s+/).filter(Boolean);
}

function findLongestWordRun(paraText, sttText) {
  const paraTokens = tokenize(paraText);
  const sttTokens = tokenize(sttText);
  if (paraTokens.length < 2 || sttTokens.length < 2) return null;

  const paraLower = paraTokens.map((t) => t.toLowerCase());
  const sttLower = sttTokens.map((t) => t.toLowerCase());

  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < paraLower.length; i++) {
    for (let j = 0; j < sttLower.length; j++) {
      let k = 0;
      while (i + k < paraLower.length && j + k < sttLower.length && paraLower[i + k] === sttLower[j + k]) k++;
      if (k > bestLen && k >= 2) { bestLen = k; bestStart = i; }
    }
  }
  if (bestStart < 0) return null;
  return { wordStart: bestStart, wordLen: bestLen };
}

function wordRangeToCharRange(paraText, wordStart, wordLen) {
  const offsets = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(paraText)) !== null) offsets.push({ start: m.index, end: m.index + m[0].length });
  if (wordStart >= offsets.length) return null;
  const lastIdx = Math.min(offsets.length - 1, wordStart + wordLen - 1);
  return { charStart: offsets[wordStart].start, charEnd: offsets[lastIdx].end };
}

function createRange(rootEl, charStart, charEnd) {
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  let charsSoFar = 0, startNode = null, startOff = 0, endNode = null, endOff = 0, node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (!startNode && charsSoFar + len > charStart) { startNode = node; startOff = charStart - charsSoFar; }
    if (startNode && charsSoFar + len >= charEnd) { endNode = node; endOff = charEnd - charsSoFar; break; }
    charsSoFar += len;
  }
  if (!startNode) return null;
  if (!endNode) { endNode = startNode; endOff = startNode.textContent.length; }
  try {
    const r = document.createRange();
    r.setStart(startNode, Math.max(0, Math.min(startOff, startNode.textContent.length)));
    r.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.textContent.length)));
    return r;
  } catch (_) { return null; }
}

// Scroll target for an alignment unit (a sentence range within a paragraph).
// When sttText is given, refine to the longest matching word run inside the
// unit — the resulting Range doubles as the "last matched" visual highlight.
function computeTargetYForUnit(para, sentStart, sentEnd, sttText) {
  const paragraphNode = state.paragraphNodes[para];
  if (!paragraphNode) return NaN;
  const paneRect = els.scrollArea.getBoundingClientRect();
  const scrollTop = els.scrollArea.scrollTop;
  const bodyEl = paragraphNode.querySelector('.body');
  const meta = state.sentMeta[para];

  if (bodyEl && meta && meta[sentStart]) {
    const unitStart = meta[sentStart].start;
    const endMeta = meta[Math.min(sentEnd, meta.length - 1)] || meta[sentStart];
    const unitEnd = endMeta.end;

    if (sttText) {
      const unitText = bodyEl.textContent.slice(unitStart, unitEnd);
      const run = findLongestWordRun(unitText, sttText);
      if (run) {
        const charRange = wordRangeToCharRange(unitText, run.wordStart, run.wordLen);
        if (charRange) {
          const r = createRange(
            bodyEl,
            unitStart + charRange.charStart,
            unitStart + charRange.charEnd
          );
          if (r) {
            state.lastMatchRange = r;
            updateMatchHighlight();
            const rect = r.getBoundingClientRect();
            if (rect.height > 0) {
              return rect.top - paneRect.top + scrollTop + rect.height / 2;
            }
          }
        }
      }
    }

    const span = (state.sentenceNodes[para] || [])[sentStart];
    if (span) {
      const rect = span.getBoundingClientRect();
      if (rect.height > 0) {
        return rect.top - paneRect.top + scrollTop + rect.height / 2;
      }
    }
  }

  const pRect = paragraphNode.getBoundingClientRect();
  return pRect.top - paneRect.top + scrollTop + 12;
}

// ============================================================
// App
// ============================================================

async function init() {
  const cfg = await window.api.getConfig();
  state.autoScrollResumeDelay = cfg.autoScrollResumeDelay || 3000;
  if (cfg.highlightColour) {
    document.documentElement.style.setProperty('--highlight', cfg.highlightColour);
  }
  // Subscribe to the webview's media events BEFORE it navigates, so the very
  // first play of the session is captured. This is what lets us derive
  // playback state purely from events and drop any DOM probing.
  initMediaWatch();
  if (cfg.audioSiteUrl) {
    els.webview.src = cfg.audioSiteUrl;
  }

  initZoom();
  initTabs();

  baseBaselineVelocity = Number.isFinite(cfg.scrollBaselineVelocity)
    ? cfg.scrollBaselineVelocity
    : SCROLL_BASELINE_V_DEFAULT;
  scrollController = new ScrollController(els.scrollArea, {
    gain: cfg.scrollGain,
    maxVelocity: cfg.scrollMaxVelocity,
    baselineVelocity: baseBaselineVelocity,
  });
  scrollController.start();
  // After scrollController exists — applySpeed() rescales its drift velocity.
  initSpeed();

  els.stopBtn.addEventListener('click', onTransportClick);
  els.settingsBtn.addEventListener('click', openSettings);
  els.fullscreenBtn.addEventListener('click', () => window.api.toggleFullScreen());
  els.fullscreenExitBtn.addEventListener('click', () => window.api.toggleFullScreen());
  window.api.onFullScreenChanged((isFull) => updateFullScreenUI(isFull));
  window.api.isFullScreen().then(updateFullScreenUI).catch(() => {});
  els.zoomInBtn.addEventListener('click', () => stepZoom(+1));
  els.zoomOutBtn.addEventListener('click', () => stepZoom(-1));
  els.speedUpBtn.addEventListener('click', () => stepSpeed(+1));
  els.speedDownBtn.addEventListener('click', () => stepSpeed(-1));

  applyShowMatchDetails(cfg.showMatchDetails);
  setDiagnosticsVisible(cfg.showDiagnostics === true);
  updateTransportUI();

  initSettingsDialog();
  initAutoLogin();
  initCopyBlock();
  initUpdateDialog();
  initDiagnostics();

  const onUserScroll = () => scrollController.pauseForUserScroll();
  els.scrollArea.addEventListener('wheel', onUserScroll, { passive: true });
  els.scrollArea.addEventListener('touchmove', onUserScroll, { passive: true });
  els.scrollArea.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) onUserScroll();
  });

  window.api.onPdfLoaded((payload) => {
    const { title, paragraphs, units } = payload || {};
    renderParagraphs(paragraphs || [], title || null, units || []);
  });
  window.api.onPositionUpdate((payload) => onPositionUpdate(payload));
  window.api.onMatchState((payload) => onMatchState(payload));
  window.api.onStatusUpdate(({ message, state: s }) => updateStatus(message, s));
  window.api.onTabActivate((name) => activateTab(name));
}

// ============================================================
// Media layer — one element picker, one transport, one poll
// ============================================================

// Every media operation goes through this single injected script. The four
// earlier snippets each picked the element by different rules, which meant
// pause, resume, speed and time-remaining could silently target different
// <audio> nodes if the site ever held a hidden preloader.
//
// NOTE: executeJavaScript runs in the webview's TOP FRAME only. If the site
// ever moves its player into an iframe, every op here returns null (and the
// media-* events, which DO fire for subframes, would keep working) — the
// symptom is dead transport controls, not a crash.
function mediaExec(op, arg) {
  if (!els.webview) return Promise.resolve(null);

  // pickMediaIndex lives in helpers.js so it can be unit-tested; it is
  // stringified in here because the choice has to be made inside the guest
  // page, where the elements actually are.
  const code = `
    (function () {
      function all() {
        return Array.prototype.slice.call(document.querySelectorAll('audio, video'));
      }

      function markActive(el) {
        all().forEach(function (o) { o.removeAttribute('data-gms-active'); });
        el.setAttribute('data-gms-active', '1');
      }

      // Install a play-tracker once per element. This is what lets us follow
      // the user to a second player on the page even when they start it from
      // the site's own controls. Idempotent — safe to re-run every call, which
      // also covers players added after page load.
      all().forEach(function (el) {
        if (el.__gmsTracked) return;
        el.__gmsTracked = true;
        el.addEventListener('play', function () { markActive(el); });
        // The first play may predate this listener (it is installed on the
        // first poll, which the play event itself triggers), so seed from the
        // current state.
        if (!el.paused && !el.ended) markActive(el);
      });

      ${pickMediaIndex.toString()}

      var list = all();
      var idx = pickMediaIndex(list.map(function (el) {
        return {
          paused: el.paused,
          ended: el.ended,
          active: el.hasAttribute('data-gms-active'),
          currentTime: el.currentTime,
          duration: el.duration,
        };
      }));
      var m = idx >= 0 ? list[idx] : null;
      if (!m) return null;

      var op = ${JSON.stringify(op)};
      if (op === 'pause') {
        try { m.pause(); } catch (_) {}
      } else if (op === 'resume') {
        try { markActive(m); var pr = m.play(); if (pr && pr.catch) pr.catch(function () {}); } catch (_) {}
      } else if (op === 'poll') {
        var rate = ${JSON.stringify(arg == null ? null : arg)};
        if (rate && m.playbackRate !== rate) { try { m.playbackRate = rate; } catch (_) {} }
      }

      return {
        t: m.currentTime,
        d: m.duration,
        r: m.playbackRate,
        paused: m.paused,
        // The webview's media-paused event fires per ELEMENT. With two players
        // on the page one can pause while the other keeps going, so the
        // renderer needs the page-wide answer before it gates transcription.
        anyPlaying: list.some(function (el) { return !el.paused && !el.ended; }),
        count: list.length,
        id: m.id || null,
      };
    })();
  `;

  // executeJavaScript can throw SYNCHRONOUSLY when the webview has not
  // attached yet (applySpeed runs during init, before src is loaded), so the
  // promise .catch() alone is not enough to keep init() alive.
  try {
    return els.webview.executeJavaScript(code).catch(() => null);
  } catch (_) {
    return Promise.resolve(null);
  }
}

// Single source of truth for playback state. Driven by the webview's own
// media events, so it stays correct when the user pauses from the site's own
// player controls rather than our button.
async function setMediaPlaying(playing) {
  if (!playing) {
    // media-paused fires per ELEMENT, and a page can carry one player per
    // reading. Pausing the second must not gate transcription while the first
    // is still running, so ask the page rather than trusting the event.
    const info = await mediaExec('poll', SPEED_LEVELS[speedIdx]);
    if (info && info.anyPlaying) {
      state.mediaPlaying = true;
      updateTransportUI();
      return;
    }
  }

  state.mediaPlaying = !!playing;

  if (state.mediaPlaying) {
    if (state.hasTranscript && !state.isListening) {
      window.api.setMediaPlaying(true);
      state.isListening = true;
      if (scrollController) scrollController.resume();
    }
    startMediaPoll();
  } else if (state.isListening) {
    // Main gates the chunk handler; it does NOT tear the pipeline down. A
    // 5-minute idle reaper there reclaims ffmpeg + whisper if we never resume.
    window.api.setMediaPlaying(false);
    state.isListening = false;
    if (scrollController) scrollController.pauseIndefinitely();
    stopMediaPoll();
  } else {
    stopMediaPoll();
  }

  updateTransportUI();
}

function updateTransportUI() {
  if (!els.stopBtn) return;
  els.stopBtn.disabled = !state.hasTranscript;
  // With no transcript the button is inert, so show the neutral Pause label
  // rather than offering to "Resume" something that never started.
  const canResume = state.hasTranscript && !state.mediaPlaying;
  els.stopBtn.textContent = canResume ? '▶ Resume' : '▐▐ Pause';
}

// Fire and forget: the webview's media event is what actually flips our state,
// so we never optimistically toggle the label here.
function onTransportClick() {
  mediaExec(state.mediaPlaying ? 'pause' : 'resume');
}

function startMediaPoll() {
  if (mediaPollTimer) return;
  pollMedia();
  mediaPollTimer = setInterval(pollMedia, MEDIA_POLL_MS);
}

function stopMediaPoll() {
  if (!mediaPollTimer) return;
  clearInterval(mediaPollTimer);
  mediaPollTimer = null;
}

async function pollMedia() {
  const info = await mediaExec('poll', SPEED_LEVELS[speedIdx]);
  if (!info) {
    els.timeRemaining.textContent = '';
    return;
  }
  const rate = Number(info.r) > 0 ? Number(info.r) : 1;
  const left = formatTime((Number(info.d) - Number(info.t)) / rate);
  els.timeRemaining.textContent = left ? `${left} left` : '';
}

function initMediaWatch() {
  els.webview.addEventListener('media-started-playing', () => setMediaPlaying(true));
  els.webview.addEventListener('media-paused', () => setMediaPlaying(false));
}

// ============================================================
// Playback speed
// ============================================================

function applySpeed() {
  const r = SPEED_LEVELS[speedIdx];
  els.speedLevel.textContent = `${r.toFixed(2)}×`;
  els.speedDownBtn.disabled = speedIdx === 0;
  els.speedUpBtn.disabled = speedIdx === SPEED_LEVELS.length - 1;
  localStorage.setItem('speedIdx', String(speedIdx));

  // Push now rather than waiting for the next poll tick.
  mediaExec('poll', r);

  // The alignment search window (AlignmentEngine.js:77) and the scroll drift
  // are both WALL-CLOCK based, but at 1.25x the transcript advances 25% faster
  // per real second. Scale both so higher speed doesn't degrade sync.
  window.api.setPlaybackRate(r);
  if (scrollController) {
    scrollController.updateTuning({ baselineVelocity: baseBaselineVelocity * r });
  }
}

function initSpeed() {
  speedIdx = readLevelIndex(localStorage.getItem('speedIdx'), SPEED_LEVELS.length, 0);
  applySpeed();
}

function stepSpeed(delta) {
  const next = stepLevel(SPEED_LEVELS.length, speedIdx, delta);
  if (next === speedIdx) return;
  speedIdx = next;
  applySpeed();
}

function renderParagraphs(paragraphs, title, units) {
  // The bar is permanent — it carries the transport controls — so a PDF with
  // no detectable title just leaves the centre text empty.
  els.transcriptTitleText.textContent = title || '';
  const hasSpeakers = paragraphs.some((p) => p && p.speaker);
  document.body.classList.toggle('has-speakers', hasSpeakers);
  els.transcript.innerHTML = '';

  state.units = Array.isArray(units) ? units : [];
  state.sentenceNodes = [];
  state.sentMeta = [];
  state.sentToUnit = [];
  state.activeUnit = -1;
  state.windowUnits = [];
  state.lastMatchRange = null;
  updateMatchHighlight();

  state.units.forEach((u, ui) => {
    if (!state.sentToUnit[u.para]) state.sentToUnit[u.para] = [];
    for (let s = u.sentStart; s <= u.sentEnd; s++) state.sentToUnit[u.para][s] = ui;
  });

  state.paragraphNodes = paragraphs.map((para, i) => {
    const p = document.createElement('p');
    p.dataset.index = String(i);

    if (para.speaker) {
      const tag = document.createElement('aside');
      tag.className = 'speaker';

      const name = document.createElement('div');
      name.className = 'speaker-name';
      name.textContent = para.speaker.name || '';

      const place = document.createElement('div');
      place.className = 'speaker-place';
      place.textContent = para.speaker.place || '';

      tag.appendChild(name);
      if (para.speaker.place) tag.appendChild(place);
      p.appendChild(tag);
    }

    const body = document.createElement('span');
    body.className = 'body';

    // Each sentence is its own clickable span so re-sync can target the exact
    // spot in a long paragraph. Char offsets into body.textContent are
    // recorded for word-run highlighting and scroll targeting.
    const sentences =
      Array.isArray(para.sentences) && para.sentences.length > 0
        ? para.sentences
        : [para.text];
    const meta = [];
    const spans = [];
    let offset = 0;

    if (para.prefix) {
      const prefixSpan = document.createElement('span');
      prefixSpan.className = 'prefix';
      prefixSpan.textContent = `${para.prefix} `;
      body.appendChild(prefixSpan);
      offset += para.prefix.length + 1;
    }

    sentences.forEach((sentence, si) => {
      const span = document.createElement('span');
      span.className = 'sentence';
      span.dataset.para = String(i);
      span.dataset.sent = String(si);
      span.textContent = sentence;
      meta.push({ start: offset, end: offset + sentence.length });
      offset += sentence.length;
      body.appendChild(span);
      if (si < sentences.length - 1) {
        body.appendChild(document.createTextNode(' '));
        offset += 1;
      }
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        resyncToUnit((state.sentToUnit[i] || [])[si]);
      });
      spans.push(span);
    });

    state.sentenceNodes[i] = spans;
    state.sentMeta[i] = meta;
    p.appendChild(body);

    // Clicks outside a sentence (margins, speaker tag) resync to the
    // paragraph's first unit.
    p.addEventListener('click', () => resyncToUnit((state.sentToUnit[i] || [])[0]));
    els.transcript.appendChild(p);
    return p;
  });

  els.transcriptEmpty.hidden = paragraphs.length > 0;
  els.documentPage.hidden = paragraphs.length === 0;
  els.diagParagraphs.textContent = `${paragraphs.length}`;

  // Re-evaluate playback state against the newly loaded transcript. The normal
  // flow is: press play (media-started-playing fires, but hasTranscript is
  // false so nothing starts) THEN click Load Transcript. Replaying the
  // event-derived flag here starts listening without a separate DOM probe.
  state.hasTranscript = state.units.length > 0;
  setMediaPlaying(state.mediaPlaying);

  // A freshly loaded document always starts at the top. The main process
  // emits position:update(0) BEFORE pdf:loaded, so any scroll target computed
  // against the previous document's DOM is stale — discard it.
  els.scrollArea.scrollTop = 0;
  if (scrollController) {
    scrollController.target = null;
    scrollController.scrollPos = 0;
    scrollController.userPausedUntil = state.isListening ? 0 : Number.POSITIVE_INFINITY;
  }
}

function onPositionUpdate(payload) {
  if (!payload || typeof payload !== 'object') return;
  const { index, para, sentStart, sentEnd, sttText } = payload;
  if (!Number.isInteger(para) || para < 0 || para >= state.paragraphNodes.length) return;

  setActiveUnit(index);
  const targetY = computeTargetYForUnit(para, sentStart, sentEnd, sttText);
  if (scrollController && Number.isFinite(targetY)) scrollController.setTarget(targetY);
}

function setActiveUnit(unitIdx) {
  if (state.activeUnit === unitIdx) return;
  applyUnitClass(state.activeUnit, 'active', false);
  state.activeUnit = Number.isInteger(unitIdx) ? unitIdx : -1;
  applyUnitClass(state.activeUnit, 'active', true);
}

function applyUnitClass(unitIdx, cls, on) {
  const u = state.units[unitIdx];
  if (!u) return;
  const spans = state.sentenceNodes[u.para] || [];
  for (let s = u.sentStart; s <= u.sentEnd && s < spans.length; s++) {
    spans[s].classList.toggle(cls, on);
  }
}

function resyncToUnit(unitIdx) {
  if (!Number.isInteger(unitIdx) || !state.units[unitIdx]) return;
  window.api.resync(unitIdx);
  setActiveUnit(unitIdx);
  state.lastMatchRange = null;
  updateMatchHighlight();
  const u = state.units[unitIdx];
  const targetY = computeTargetYForUnit(u.para, u.sentStart, u.sentEnd, null);
  if (scrollController && Number.isFinite(targetY)) {
    scrollController.setTarget(targetY);
    scrollController.jumpToTarget();
  }
}

// ============================================================
// Match visibility (Phase 2) — matched word run + search window
// ============================================================

function updateMatchHighlight() {
  if (!('highlights' in CSS)) return;
  if (state.showMatchDetails && state.lastMatchRange) {
    CSS.highlights.set('gms-match', new Highlight(state.lastMatchRange));
  } else {
    CSS.highlights.delete('gms-match');
  }
}

function setWindowRange(from, to) {
  for (const ui of state.windowUnits) applyUnitClass(ui, 'in-window', false);
  state.windowUnits = [];
  if (!state.showMatchDetails) return;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return;
  for (let ui = from; ui < to && ui < state.units.length; ui++) {
    applyUnitClass(ui, 'in-window', true);
    state.windowUnits.push(ui);
  }
}

function onMatchState(payload) {
  if (!payload || typeof payload !== 'object') return;
  const { window: win } = payload;

  if (win) setWindowRange(win.from, win.to);
  // The numeric readout moved to the diagnostics panel (main.js keeps
  // diag.lastMatch up to date); the in-transcript highlighting stays here.
}

function applyShowMatchDetails(enabled) {
  state.showMatchDetails = enabled !== false;
  document.body.classList.toggle('show-match-details', state.showMatchDetails);
  if (!state.showMatchDetails) {
    setWindowRange(null, null);
  }
  updateMatchHighlight();
}

// Healthy states render as a bare coloured dot; only 'lost' carries visible
// text, and that text persists until the state changes. main.js sends real
// setup failures through here ("No audio captured — check FFmpeg setup",
// "Load a PDF first") and with the Listen button gone this is their only
// surface in the UI.
function updateStatus(message, s) {
  const msg = message || '';
  if (s) els.status.dataset.state = s;
  const isError = (s || els.status.dataset.state) === 'lost';
  els.status.textContent = isError ? msg : '';
  els.status.title = msg || 'Pipeline state';
  if (els.diagStatus) els.diagStatus.textContent = msg || '—';
}

// Whisper's cold start is slow — first run downloads ~500MB and loading the
// model takes ~30s. Without this, pressing play looks like nothing happening.
function updateWhisperHint(whisperState) {
  if (!whisperState || els.status.dataset.state === 'lost') return;
  if (/loading|starting/i.test(whisperState)) {
    els.status.textContent = whisperState;
    els.status.title = whisperState;
  } else if (els.status.textContent) {
    els.status.textContent = '';
  }
}

// ============================================================
// Zoom
// ============================================================

function applyZoom() {
  const z = ZOOM_LEVELS[zoomIdx];
  document.documentElement.style.setProperty('--zoom', String(z));
  els.zoomLevel.textContent = `${Math.round(z * 100)}%`;
  els.zoomOutBtn.disabled = zoomIdx === 0;
  els.zoomInBtn.disabled = zoomIdx === ZOOM_LEVELS.length - 1;
  localStorage.setItem('zoomIdx', String(zoomIdx));
}
function initZoom() {
  zoomIdx = readLevelIndex(localStorage.getItem('zoomIdx'), ZOOM_LEVELS.length, ZOOM_LEVELS.indexOf(1.0));
  applyZoom();
}
function stepZoom(delta) {
  const next = stepLevel(ZOOM_LEVELS.length, zoomIdx, delta);
  if (next === zoomIdx) return;
  zoomIdx = next;
  applyZoom();
}

// ============================================================
// Copy block (transcript text is sensitive / copyright)
// ============================================================

function initCopyBlock() {
  const insideTranscript = (target) =>
    target instanceof Node && els.transcript.contains(target);

  const block = (e) => {
    if (insideTranscript(e.target)) e.preventDefault();
  };
  ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach((ev) => {
    document.addEventListener(ev, block);
  });

  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const insideScroll = els.scrollArea.contains(document.activeElement) ||
      insideTranscript(document.activeElement);
    if (!insideScroll && document.activeElement !== document.body) return;
    const k = e.key.toLowerCase();
    if (k === 'a' || k === 'c' || k === 'x') {
      // Only swallow when focus isn't in a form field (settings dialog).
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
    }
  });
}

// ============================================================
// Fullscreen
// ============================================================

function updateFullScreenUI(isFull) {
  document.body.classList.toggle('fullscreen', !!isFull);
  if (els.fullscreenBtn) {
    els.fullscreenBtn.textContent = isFull ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
  }
}

// ============================================================
// Tabs
// ============================================================

function initTabs() {
  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });
  // Always land on Browser at startup: no transcript is loaded yet, and with
  // Load PDF gone the Browser tab is the only way to load one. main.js sends
  // tab:activate('transcript') once a download completes.
  activateTab('browser');
}

function activateTab(name) {
  if (!els.tabPanels[name]) name = 'transcript';
  state.activeTab = name;

  els.tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });
  Object.entries(els.tabPanels).forEach(([k, panel]) => {
    panel.classList.toggle('active', k === name);
  });

  // The Browser tab has no title bar, so it has no fullscreen button — this
  // class is what reveals the floating exit pill there (styles.css).
  document.body.classList.toggle('tab-browser', name === 'browser');

  localStorage.setItem('activeTab', name);

  if (name === 'transcript' && scrollController) {
    scrollController.scrollPos = els.scrollArea.scrollTop;
  }
}

// ============================================================
// Settings dialog + auto-login
// ============================================================

function initSettingsDialog() {
  els.settingsSaveBtn.addEventListener('click', onSaveSettings);
  els.settingsCancelBtn.addEventListener('click', () => els.settingsDialog.close());
  els.settingsClearBtn.addEventListener('click', onClearSettings);
}

async function openSettings() {
  try {
    const creds = await window.api.getCredentials();
    if (creds) {
      els.settingsUsername.value = creds.username || '';
      els.settingsPassword.value = creds.password || '';
      els.settingsAutosubmit.checked = creds.autosubmit !== false;
    } else {
      els.settingsUsername.value = '';
      els.settingsPassword.value = '';
      els.settingsAutosubmit.checked = true;
    }
  } catch (_) {
    // ignore — dialog still opens with empty fields
  }

  try {
    const s = await window.api.getSettings();
    if (s) {
      els.settingsWhisperModel.value = s.whisperModel || 'small';
      els.settingsShowMatch.checked = s.showMatchDetails !== false;
      els.settingsFuseThreshold.value = s.fuseThreshold ?? 0.35;
      els.settingsExpansionRate.value = s.windowExpansionRate ?? 1.0;
      els.settingsShowDiagnostics.checked = s.showDiagnostics === true;
      els.settingsScrollGain.value = s.scrollGain ?? SCROLL_GAIN_DEFAULT;
      els.settingsScrollBaseline.value = s.scrollBaselineVelocity ?? SCROLL_BASELINE_V_DEFAULT;
      els.settingsScrollMax.value = s.scrollMaxVelocity ?? SCROLL_MAX_V_DEFAULT;
      els.settingsVerboseLogging.checked = s.verboseLogging === true;
    }
  } catch (_) {
    // ignore
  }

  try {
    const version = await window.api.getVersion();
    els.settingsVersion.textContent = version ? `Version ${version}` : '';
  } catch (_) {
    els.settingsVersion.textContent = '';
  }

  els.settingsDialog.showModal();
}

async function onSaveSettings() {
  // Credentials
  const credPayload = {
    username: els.settingsUsername.value,
    password: els.settingsPassword.value,
    autosubmit: els.settingsAutosubmit.checked,
  };
  const credResult = await window.api.saveCredentials(credPayload);
  if (!credResult || !credResult.ok) {
    alert(credResult && credResult.error ? credResult.error : 'Failed to save credentials');
    return;
  }

  // Tuning / advanced settings
  const settingsPayload = {
    whisperModel: els.settingsWhisperModel.value,
    showMatchDetails: els.settingsShowMatch.checked,
    fuseThreshold: parseFloat(els.settingsFuseThreshold.value),
    windowExpansionRate: parseFloat(els.settingsExpansionRate.value),
    showDiagnostics: els.settingsShowDiagnostics.checked,
    scrollGain: parseFloat(els.settingsScrollGain.value),
    scrollBaselineVelocity: parseFloat(els.settingsScrollBaseline.value),
    scrollMaxVelocity: parseFloat(els.settingsScrollMax.value),
    verboseLogging: els.settingsVerboseLogging.checked,
  };
  const settingsResult = await window.api.saveSettings(settingsPayload);
  if (!settingsResult || !settingsResult.ok) {
    alert(settingsResult && settingsResult.error ? settingsResult.error : 'Failed to save settings');
    return;
  }

  // Apply runtime changes immediately
  if (settingsResult.settings) {
    baseBaselineVelocity = settingsResult.settings.scrollBaselineVelocity;
    if (scrollController) {
      scrollController.updateTuning({
        gain: settingsResult.settings.scrollGain,
        maxVelocity: settingsResult.settings.scrollMaxVelocity,
        // Wall-clock drift, so it tracks playback speed. See applySpeed().
        baselineVelocity: baseBaselineVelocity * SPEED_LEVELS[speedIdx],
      });
    }
    applyShowMatchDetails(settingsResult.settings.showMatchDetails);
    setDiagnosticsVisible(settingsResult.settings.showDiagnostics === true);
  }

  els.settingsDialog.close();
  // Re-trigger auto-fill so credentials changes take effect immediately
  tryAutoFill();
}

async function onClearSettings() {
  await window.api.clearCredentials();
  els.settingsUsername.value = '';
  els.settingsPassword.value = '';
}

function initAutoLogin() {
  els.webview.addEventListener('did-finish-load', () => {
    setTimeout(tryAutoFill, 400);
    setTimeout(tryRelabelDownloadLinks, 600);
  });
  els.webview.addEventListener('did-navigate-in-page', () => {
    setTimeout(tryRelabelDownloadLinks, 200);
  });
}

// Rewrite any "Download" text on links/buttons in the audio site to
// "Load Transcript". Idempotent via a data-gms-relabelled marker so SPA
// re-renders don't loop. The underlying href / click behaviour is unchanged
// — clicking still triggers the download intercept in main.js.
async function tryRelabelDownloadLinks() {
  if (!els.webview) return;
  const code = `
    (function () {
      const TARGETS = /^\\s*(download(\\s+pdf)?)\\s*$/i;
      const REPLACEMENT = 'Load Transcript';
      const nodes = document.querySelectorAll('a, button, span, div');
      let count = 0;
      for (const el of nodes) {
        if (el.getAttribute('data-gms-relabelled') === '1') continue;
        // Only relabel leaf-ish elements whose own text matches.
        const txt = (el.textContent || '').trim();
        if (!TARGETS.test(txt)) continue;
        // Avoid clobbering elements that contain other interactive children.
        if (el.querySelector('a, button, input, select, textarea')) continue;
        // Replace only direct text nodes; leave inner elements alone.
        let replaced = false;
        for (const child of Array.from(el.childNodes)) {
          if (child.nodeType === 3 && TARGETS.test(child.textContent.trim())) {
            child.textContent = REPLACEMENT;
            replaced = true;
          }
        }
        if (!replaced && TARGETS.test(txt)) {
          el.textContent = REPLACEMENT;
          replaced = true;
        }
        if (replaced) {
          el.setAttribute('data-gms-relabelled', '1');
          count++;
        }
      }
      return count;
    })();
  `;
  try { await els.webview.executeJavaScript(code); }
  catch (_) { /* ignore */ }
}

async function tryAutoFill() {
  let creds;
  try {
    creds = await window.api.getCredentials();
  } catch (_) {
    return;
  }
  if (!creds || !creds.username || !creds.password) return;

  const username = JSON.stringify(creds.username);
  const password = JSON.stringify(creds.password);
  const autoSubmit = JSON.stringify(creds.autosubmit !== false);

  const code = `
    (function(username, password, autoSubmit) {
      try {
        const pwd = document.querySelector('input[type="password"]:not([disabled])');
        if (!pwd) return false;

        let user = document.querySelector(
          'input[type="email"]:not([disabled]), ' +
          'input[type="text"][name*="user" i]:not([disabled]), ' +
          'input[type="text"][name*="email" i]:not([disabled]), ' +
          'input[type="text"][autocomplete*="username"]:not([disabled]), ' +
          'input[type="text"][autocomplete*="email"]:not([disabled])'
        );
        if (!user) {
          const all = Array.from(document.querySelectorAll('input'));
          const idx = all.indexOf(pwd);
          for (let i = idx - 1; i >= 0; i--) {
            const t = all[i].type;
            if (t === 'text' || t === 'email' || t === '') { user = all[i]; break; }
          }
        }
        if (!user) return false;

        // Skip if user has already typed something
        if (user.value && user.value.length > 0 && pwd.value && pwd.value.length > 0) return 'already-filled';

        function setVal(input, val) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, val);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setVal(user, username);
        setVal(pwd, password);

        if (autoSubmit) {
          setTimeout(function() {
            const form = pwd.form;
            const submit = form && (form.querySelector('button[type="submit"]') || form.querySelector('input[type="submit"]') || form.querySelector('button:not([type])'));
            if (submit) submit.click();
            else if (form && form.requestSubmit) form.requestSubmit();
          }, 250);
        }
        return true;
      } catch (e) {
        return 'error: ' + (e && e.message || e);
      }
    })(${username}, ${password}, ${autoSubmit});
  `;

  try {
    const result = await els.webview.executeJavaScript(code);
    if (result === true) console.log('[AutoLogin] filled');
    else if (typeof result === 'string') console.log('[AutoLogin]', result);
  } catch (err) {
    console.warn('[AutoLogin] inject failed:', err && err.message);
  }
}

// ===== Diagnostics panel =====

let diagRefreshTimer = null;

function renderDiagnostics(d) {
  if (!d) return;
  els.diagAudioDevice.textContent = d.audioDevice || '—';
  els.diagFfmpeg.textContent = d.ffmpegPath || '—';
  els.diagPython.textContent = d.pythonPath || '—';
  els.diagWhisper.textContent = d.whisperState || '—';
  els.diagChunks.textContent = String(d.chunks ?? 0);
  els.diagTranscriptions.textContent = String(d.transcriptions ?? 0);
  els.diagLastText.textContent = d.lastText || '—';
  els.diagLastMatch.textContent = d.lastMatch || '—';
  els.diagLogPath.textContent = d.logPath || '—';
  if (Array.isArray(d.recentLog)) {
    els.diagLog.textContent = d.recentLog.join('\n');
    els.diagLog.scrollTop = els.diagLog.scrollHeight;
  }
}

async function refreshDiagnostics() {
  try {
    renderDiagnostics(await window.api.getDiagnostics());
  } catch (_) {
    // ignore
  }
}

// Sole owner of both the panel's hidden flag and its refresh timer, so the
// Settings checkbox, the panel's close button and the startup apply all go
// through one path.
function setDiagnosticsVisible(show) {
  els.diagPanel.hidden = !show;
  if (show) {
    refreshDiagnostics();
    if (!diagRefreshTimer) diagRefreshTimer = setInterval(refreshDiagnostics, 2000);
  } else if (diagRefreshTimer) {
    clearInterval(diagRefreshTimer);
    diagRefreshTimer = null;
  }
}

function initDiagnostics() {
  els.diagClose.addEventListener('click', async () => {
    setDiagnosticsVisible(false);
    // Persist the preference. Read the full settings first — settings:save
    // falls back to hardcoded defaults (not stored values) for any key the
    // payload omits, so a partial write would silently reset your tuning.
    try {
      const current = await window.api.getSettings();
      if (current) await window.api.saveSettings({ ...current, showDiagnostics: false });
    } catch (_) {
      // Session-only hide is an acceptable fallback.
    }
  });
  // Live counter updates while listening (cheap — panel may be closed).
  window.api.onDiagUpdate((d) => {
    updateWhisperHint(d && d.whisperState);
    if (!els.diagPanel.hidden) renderDiagnostics(d);
  });
}

// ===== Auto-update modal =====

// Release notes arrive from the GitHub release body — a string, or (rarely) an
// array of { version, note }. Render as plain text to avoid injecting markup.
function formatReleaseNotes(notes) {
  if (!notes) return 'No release notes provided.';
  if (Array.isArray(notes)) {
    return notes.map((n) => (typeof n === 'string' ? n : n.note || '')).join('\n\n');
  }
  // GitHub bodies can contain HTML tags; strip them for a clean text view.
  return String(notes).replace(/<[^>]+>/g, '').trim() || 'No release notes provided.';
}

function initUpdateDialog() {
  let downloaded = false;

  els.updateLaterBtn.addEventListener('click', () => els.updateDialog.close());

  els.updateActionBtn.addEventListener('click', async () => {
    if (downloaded) {
      await window.api.installUpdate();
      return;
    }
    // Start download — swap the button for a progress bar.
    els.updateActionBtn.disabled = true;
    els.updateActionBtn.textContent = 'Downloading…';
    els.updateProgressWrap.hidden = false;
    try {
      await window.api.downloadUpdate();
    } catch (err) {
      els.updateActionBtn.disabled = false;
      els.updateActionBtn.textContent = 'Download & Install';
      els.updateProgressLabel.textContent = `Download failed: ${err && err.message ? err.message : err}`;
    }
  });

  window.api.onUpdateAvailable((p) => {
    downloaded = false;
    els.updateTitle.textContent = `Update available — v${p.version}`;
    els.updateSubtitle.textContent = 'A new version of GMS Scroller is ready to install.';
    els.updateNotes.textContent = formatReleaseNotes(p.releaseNotes);
    els.updateProgressWrap.hidden = true;
    els.updateProgressFill.style.width = '0%';
    els.updateActionBtn.disabled = false;
    els.updateActionBtn.textContent = 'Download & Install';
    if (!els.updateDialog.open) els.updateDialog.showModal();
  });

  window.api.onUpdateProgress((p) => {
    const pct = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
    els.updateProgressFill.style.width = `${pct}%`;
    els.updateProgressLabel.textContent = `Downloading… ${pct}%`;
  });

  window.api.onUpdateDownloaded(() => {
    downloaded = true;
    els.updateProgressFill.style.width = '100%';
    els.updateProgressLabel.textContent = 'Download complete.';
    els.updateActionBtn.disabled = false;
    els.updateActionBtn.textContent = 'Restart & Install';
  });
}

init();
