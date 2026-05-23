// Kingdom of Agents — slim DOM HUD.
//
// Responsibilities (deliberately tiny):
//   - Theme toggle (sun/moon) that flips body.theme-light and persists
//     the choice in `koa_theme` localStorage. The Phaser scene listens
//     via `window.__koaSetTheme(mode)` and re-renders with light/dark
//     color tokens.
//   - Ops status surface in the top bar (chip + recommendation +
//     alerts badge). The scene calls `window.__koaUpdateOps(summary,
//     alerts)` each time it recomputes opsSummary.
//
// No score/lives/level/pause/game-switcher/settings — this is an
// observability tool, not an arcade. All operational status (active
// sessions, attention alerts, replay state) lives in the canvas.

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  function safeGet(key) {
    try { return localStorage.getItem(key); }
    catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); }
    catch (e) { /* quota or private mode — non-fatal */ }
  }

  // -------------------------------------------------------------------
  // Theme toggle (light/dark).
  // -------------------------------------------------------------------

  var themeBtn = $('theme-btn');
  var currentTheme = safeGet('koa_theme') === 'light' ? 'light' : 'dark';

  function applyTheme() {
    var isLight = currentTheme === 'light';
    document.body.classList.toggle('theme-light', isLight);
    if (themeBtn) {
      // Show the icon for the mode you'll switch INTO.
      themeBtn.textContent = isLight ? '🌙' : '☀️';
      themeBtn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
    }
    if (typeof window.__koaSetTheme === 'function') {
      window.__koaSetTheme(currentTheme);
    }
  }

  function toggleTheme() {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    safeSet('koa_theme', currentTheme);
    applyTheme();
  }

  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  // Apply immediately so the topbar is correct before Phaser mounts,
  // then re-apply once the scene installs __koaSetTheme so the canvas
  // picks up the same mode.
  applyTheme();
  var attempts = 0;
  var poll = setInterval(function () {
    attempts++;
    if (typeof window.__koaSetTheme === 'function' || attempts > 40) {
      clearInterval(poll);
      applyTheme();
    }
  }, 100);

  // -------------------------------------------------------------------
  // Ops status surface (top-bar chip + recommendation + alert badge).
  // -------------------------------------------------------------------

  var chipEl  = $('ops-chip');
  var recEl   = $('ops-rec');
  var alertEl = $('ops-alert');

  // Map the scene's attention levels to chip CSS classes. Anything
  // unknown falls back to 'calm' so we never render an unstyled chip.
  var ATTENTION_CLASSES = { calm: 'calm', watch: 'watch', review: 'review' };

  function setChip(label, attention) {
    if (!chipEl) return;
    var cls = ATTENTION_CLASSES[attention] || 'calm';
    chipEl.className = cls;
    chipEl.textContent = (label || 'idle').toUpperCase();
  }

  function setRecommendation(text, isPlaceholder) {
    if (!recEl) return;
    var value = text || 'Waiting for Copilot CLI activity…';
    recEl.textContent = value;
    recEl.title = value;
    recEl.classList.toggle('muted', !!isPlaceholder);
  }

  function setAlerts(alerts) {
    if (!alertEl) return;
    var list = Array.isArray(alerts) ? alerts.filter(Boolean) : [];
    if (list.length === 0) {
      alertEl.classList.remove('visible');
      alertEl.textContent = '';
      alertEl.title = '';
      return;
    }
    alertEl.classList.add('visible');
    alertEl.textContent = '! ' + list.length + (list.length === 1 ? ' alert' : ' alerts');
    alertEl.title = list.join('\n');
  }

  // Public API the scene calls after each opsSummary recompute.
  window.__koaUpdateOps = function (summary, alerts) {
    if (!summary) {
      setChip('idle', 'calm');
      setRecommendation('', true);
      setAlerts([]);
      return;
    }
    setChip(summary.mode, summary.attention);
    var rec = summary.recommendation || '';
    var isPlaceholder = !rec || /^run github copilot cli/i.test(rec);
    setRecommendation(rec, isPlaceholder);
    setAlerts(alerts || []);
  };

  // -------------------------------------------------------------------
  // Active model chip in the topbar. The scene calls this whenever the
  // selected session changes OR when its `last_model` value changes
  // between scans (so mid-session model switches surface immediately).
  // Pass an empty string to hide the chip — used on scene shutdown and
  // when no session has emitted a model-bearing event yet.
  // -------------------------------------------------------------------

  var modelEl = $('model-chip');
  var lastModel = '';

  window.__koaUpdateModel = function (model) {
    if (!modelEl) return;
    var next = (model == null ? '' : String(model)).trim();
    if (next === lastModel) return;
    lastModel = next;
    if (next === '') {
      modelEl.classList.add('empty');
      modelEl.textContent = '';
      modelEl.title = 'Active model for the selected session';
    } else {
      modelEl.classList.remove('empty');
      modelEl.textContent = next;
      modelEl.title = 'Active model: ' + next;
    }
  };

  // -------------------------------------------------------------------
  // Panels toggle — hide/show the Summary + Selected Session + Activity
  // Feed side panels so the castle/buildings ring can expand to take up
  // the full width. The district inspector below the buildings + the
  // replay timeline stay visible so hover/click behavior + scrubber
  // controls keep working in focus mode.
  // -------------------------------------------------------------------

  var panelsBtn = $('panels-btn');
  var panelsHidden = safeGet('koa_panels_hidden') === '1';

  // Two-state icon (state-based, like password-field toggles): icon
  // shows what's currently visible. Open eye when panels are shown,
  // eye-with-slash when panels are hidden. The tooltip describes the
  // click action so the meaning stays unambiguous either way.
  // Deep almond curve (peaks at y=3 / y=21 in a 24x24 box) + filled
  // pupil so the icon reads at the topbar size without looking like a
  // squashed slit.
  var ICON_EYE_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M2 12 Q 12 3 22 12 Q 12 21 2 12 Z"/>'
    + '<circle class="pupil" cx="12" cy="12" r="3.5"/>'
    + '</svg>';
  var ICON_EYE_SLASH = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M2 12 Q 12 3 22 12 Q 12 21 2 12 Z"/>'
    + '<circle class="pupil" cx="12" cy="12" r="3.5"/>'
    + '<path d="M4 20 L 20 4"/>'
    + '</svg>';

  function applyPanelsState() {
    if (panelsBtn) {
      panelsBtn.innerHTML = panelsHidden ? ICON_EYE_SLASH : ICON_EYE_OPEN;
      panelsBtn.title = panelsHidden
        ? 'Show side panels'
        : 'Hide side panels for focus mode';
      panelsBtn.setAttribute('aria-pressed', panelsHidden ? 'true' : 'false');
    }
    if (typeof window.__koaSetPanelsHidden === 'function') {
      window.__koaSetPanelsHidden(panelsHidden);
    }
  }

  function togglePanels() {
    panelsHidden = !panelsHidden;
    safeSet('koa_panels_hidden', panelsHidden ? '1' : '0');
    applyPanelsState();
  }

  if (panelsBtn) panelsBtn.addEventListener('click', togglePanels);

  // Apply once now (paints the icon), then poll briefly for the scene
  // hook the same way the theme toggle does so the initial state hits
  // Phaser once the scene is mounted.
  applyPanelsState();
  var panelsAttempts = 0;
  var panelsPoll = setInterval(function () {
    panelsAttempts++;
    if (typeof window.__koaSetPanelsHidden === 'function' || panelsAttempts > 40) {
      clearInterval(panelsPoll);
      applyPanelsState();
    }
  }, 100);
})();
