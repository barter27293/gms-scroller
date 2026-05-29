const els = {
  loadBtn: document.getElementById('btn-load-pdf'),
  listenBtn: document.getElementById('btn-listen'),
  stopBtn: document.getElementById('btn-stop'),
  settingsBtn: document.getElementById('btn-settings'),
  fullscreenBtn: document.getElementById('btn-fullscreen'),
  fullscreenExitBtn: document.getElementById('btn-fullscreen-exit'),
  zoomInBtn: document.getElementById('btn-zoom-in'),
  zoomOutBtn: document.getElementById('btn-zoom-out'),
  zoomLevel: document.getElementById('zoom-level'),
  tabs: document.querySelectorAll('#tabs .tab'),
  tabPanels: {
    transcript: document.getElementById('tab-transcript'),
    browser: document.getElementById('tab-browser'),
  },
  status: document.getElementById('status'),
  paragraphCount: document.getElementById('paragraph-count'),
  transcript: document.getElementById('transcript'),
  transcriptTitle: document.getElementById('transcript-title'),
  transcriptEmpty: document.getElementById('transcript-empty'),
  documentPage: document.getElementById('document-page'),
  scrollArea: document.getElementById('scroll-area'),
  webview: document.getElementById('audioSite'),

  settingsDialog: document.getElementById('settings-dialog'),
  settingsUsername: document.getElementById('settings-username'),
  settingsPassword: document.getElementById('settings-password'),
  settingsAutosubmit: document.getElementById('settings-autosubmit'),
  settingsFuseThreshold: document.getElementById('settings-fuse-threshold'),
  settingsParagraphsPerSec: document.getElementById('settings-paragraphs-per-sec'),
  settingsScrollGain: document.getElementById('settings-scroll-gain'),
  settingsScrollBaseline: document.getElementById('settings-scroll-baseline'),
  settingsScrollMax: document.getElementById('settings-scroll-max'),
  settingsVerboseLogging: document.getElementById('settings-verbose-logging'),
  settingsSaveBtn: document.getElementById('settings-save'),
  settingsCancelBtn: document.getElementById('settings-cancel'),
  settingsClearBtn: document.getElementById('settings-clear'),

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
  autoScrollResumeDelay: 3000,
  isListening: false,
  activeTab: 'transcript',
};

// ---- Scroll controller defaults (overridable per-instance from config) ----
const SCROLL_GAIN_DEFAULT = 0.35;
const SCROLL_MAX_V_DEFAULT = 90;
const SCROLL_BASELINE_V_DEFAULT = 3;
const SCROLL_DEAD_ZONE = 40; // px from target before we taper toward baseline

// ---- Zoom levels ----
const ZOOM_LEVELS = [0.75, 0.85, 0.95, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0];
let zoomIdx = ZOOM_LEVELS.indexOf(1.0);

let scrollController = null;

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

function computeTargetY(paragraphNode, sttText) {
  const paneRect = els.scrollArea.getBoundingClientRect();
  const scrollTop = els.scrollArea.scrollTop;

  const bodyEl = paragraphNode.querySelector('.body');
  const targetEl = bodyEl || paragraphNode;

  if (sttText) {
    const run = findLongestWordRun(targetEl.textContent, sttText);
    if (run) {
      const charRange = wordRangeToCharRange(targetEl.textContent, run.wordStart, run.wordLen);
      if (charRange) {
        const r = createRange(targetEl, charRange.charStart, charRange.charEnd);
        if (r) {
          const rect = r.getBoundingClientRect();
          if (rect.height > 0) {
            return rect.top - paneRect.top + scrollTop + rect.height / 2;
          }
        }
      }
    }
  }

  const pRect = paragraphNode.getBoundingClientRect();
  const offset = bodyEl ? (bodyEl.getBoundingClientRect().top - pRect.top) : 0;
  return pRect.top - paneRect.top + scrollTop + offset + 12;
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
  if (cfg.audioSiteUrl) {
    els.webview.src = cfg.audioSiteUrl;
  }

  initZoom();
  initTabs();

  scrollController = new ScrollController(els.scrollArea, {
    gain: cfg.scrollGain,
    maxVelocity: cfg.scrollMaxVelocity,
    baselineVelocity: cfg.scrollBaselineVelocity,
  });
  scrollController.start();

  els.loadBtn.addEventListener('click', onLoadPdf);
  els.listenBtn.addEventListener('click', onListen);
  els.stopBtn.addEventListener('click', onStop);
  els.settingsBtn.addEventListener('click', openSettings);
  els.fullscreenBtn.addEventListener('click', () => window.api.toggleFullScreen());
  els.fullscreenExitBtn.addEventListener('click', () => window.api.toggleFullScreen());
  window.api.onFullScreenChanged((isFull) => updateFullScreenUI(isFull));
  window.api.isFullScreen().then(updateFullScreenUI).catch(() => {});
  els.zoomInBtn.addEventListener('click', () => stepZoom(+1));
  els.zoomOutBtn.addEventListener('click', () => stepZoom(-1));

  initSettingsDialog();
  initAutoLogin();
  initCopyBlock();
  initUpdateDialog();

  const onUserScroll = () => scrollController.pauseForUserScroll();
  els.scrollArea.addEventListener('wheel', onUserScroll, { passive: true });
  els.scrollArea.addEventListener('touchmove', onUserScroll, { passive: true });
  els.scrollArea.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) onUserScroll();
  });

  window.api.onPdfLoaded((payload) => {
    const { title, paragraphs } = payload || {};
    renderParagraphs(paragraphs || [], title || null);
  });
  window.api.onPositionUpdate((payload) => onPositionUpdate(payload));
  window.api.onStatusUpdate(({ message, state: s }) => updateStatus(message, s));
  window.api.onTabActivate((name) => activateTab(name));
}

async function onLoadPdf() {
  const filePath = await window.api.pickPdf();
  if (!filePath) return;
  const result = await window.api.loadPdf(filePath);
  if (!result || !result.ok) {
    updateStatus(result && result.error ? result.error : 'Failed to load PDF', 'lost');
  }
}

function onListen() {
  window.api.listenStart();
  state.isListening = true;
  els.listenBtn.disabled = true;
  els.stopBtn.disabled = false;
  if (scrollController) scrollController.resume();
  if (state.audioWasPaused) {
    resumeWebviewMedia();
    state.audioWasPaused = false;
  }
}

function onStop() {
  window.api.listenStop();
  state.isListening = false;
  els.listenBtn.disabled = false;
  els.stopBtn.disabled = true;
  if (scrollController) scrollController.pauseIndefinitely();
  pauseWebviewMedia().then((wasPlaying) => {
    state.audioWasPaused = wasPlaying;
  });
}

// Pause the first playing <audio>/<video> in the embedded site and tag it so
// we can resume it later. Returns true if something was paused.
async function pauseWebviewMedia() {
  if (!els.webview) return false;
  const code = `
    (function () {
      const m = Array.from(document.querySelectorAll('audio, video'))
        .find((el) => !el.paused && !el.ended);
      if (!m) return false;
      m.setAttribute('data-gms-paused', '1');
      try { m.pause(); } catch (_) {}
      return true;
    })();
  `;
  try { return await els.webview.executeJavaScript(code); }
  catch (_) { return false; }
}

async function resumeWebviewMedia() {
  if (!els.webview) return;
  const code = `
    (function () {
      const m = document.querySelector('audio[data-gms-paused="1"], video[data-gms-paused="1"]');
      if (!m) return false;
      m.removeAttribute('data-gms-paused');
      try { const p = m.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) {}
      return true;
    })();
  `;
  try { await els.webview.executeJavaScript(code); }
  catch (_) { /* ignore */ }
}

function renderParagraphs(paragraphs, title) {
  if (title) {
    els.transcriptTitle.textContent = title;
    els.transcriptTitle.hidden = false;
  } else {
    els.transcriptTitle.textContent = '';
    els.transcriptTitle.hidden = true;
  }
  const hasSpeakers = paragraphs.some((p) => p && p.speaker);
  document.body.classList.toggle('has-speakers', hasSpeakers);
  els.transcript.innerHTML = '';
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
    body.textContent = para.text;
    p.appendChild(body);

    p.addEventListener('click', () => onParagraphClick(i));
    els.transcript.appendChild(p);
    return p;
  });

  els.transcriptEmpty.hidden = paragraphs.length > 0;
  els.documentPage.hidden = paragraphs.length === 0;
  els.paragraphCount.textContent = `${paragraphs.length} paragraphs`;
}

function onPositionUpdate(payload) {
  const index = payload && typeof payload === 'object' ? payload.index : payload;
  const sttText = payload && typeof payload === 'object' ? payload.sttText : null;
  if (index < 0 || index >= state.paragraphNodes.length) return;

  const paragraphNode = state.paragraphNodes[index];
  if (!paragraphNode) return;

  const targetY = computeTargetY(paragraphNode, sttText);
  if (scrollController && Number.isFinite(targetY)) scrollController.setTarget(targetY);
}

function onParagraphClick(index) {
  window.api.resync(index);
  const paragraphNode = state.paragraphNodes[index];
  if (!paragraphNode || !scrollController) return;
  const targetY = computeTargetY(paragraphNode, null);
  if (Number.isFinite(targetY)) {
    scrollController.setTarget(targetY);
    scrollController.jumpToTarget();
  }
}

function updateStatus(message, s) {
  els.status.textContent = message || '';
  if (s) els.status.dataset.state = s;
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
  const saved = parseInt(localStorage.getItem('zoomIdx'), 10);
  if (!Number.isNaN(saved) && saved >= 0 && saved < ZOOM_LEVELS.length) zoomIdx = saved;
  applyZoom();
}
function stepZoom(delta) {
  const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIdx + delta));
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
  const saved = localStorage.getItem('activeTab') || 'transcript';
  activateTab(saved);
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
      els.settingsFuseThreshold.value = s.fuseThreshold ?? 0.35;
      els.settingsParagraphsPerSec.value = s.alignmentParagraphsPerSecond ?? 1.0;
      els.settingsScrollGain.value = s.scrollGain ?? SCROLL_GAIN_DEFAULT;
      els.settingsScrollBaseline.value = s.scrollBaselineVelocity ?? SCROLL_BASELINE_V_DEFAULT;
      els.settingsScrollMax.value = s.scrollMaxVelocity ?? SCROLL_MAX_V_DEFAULT;
      els.settingsVerboseLogging.checked = s.verboseLogging === true;
    }
  } catch (_) {
    // ignore
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
    fuseThreshold: parseFloat(els.settingsFuseThreshold.value),
    alignmentParagraphsPerSecond: parseFloat(els.settingsParagraphsPerSec.value),
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

  // Apply runtime changes to ScrollController immediately
  if (scrollController && settingsResult.settings) {
    scrollController.updateTuning({
      gain: settingsResult.settings.scrollGain,
      maxVelocity: settingsResult.settings.scrollMaxVelocity,
      baselineVelocity: settingsResult.settings.scrollBaselineVelocity,
    });
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
