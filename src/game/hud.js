// Copilot Mission Control — slim DOM HUD.
//
// Responsibilities (deliberately tiny):
//   - Theme toggle (sun/moon) that flips body.theme-light and persists
//     the choice in `cmc_theme` localStorage. The Phaser scene listens
//     via `window.__cmcSetTheme(mode)` and re-renders with light/dark
//     color tokens.
//   - DOM dashboard chrome, replay controls, settings, and inspector dialog.
//
// No score/lives/level/pause/game-switcher — this is an
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
  var currentTheme = safeGet('cmc_theme') === 'light' ? 'light' : 'dark';

  function applyTheme() {
    var isLight = currentTheme === 'light';
    document.body.classList.toggle('theme-light', isLight);
    if (themeBtn) {
      // Show the icon for the mode you'll switch INTO.
      themeBtn.textContent = isLight ? '🌙' : '☀️';
      themeBtn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
      themeBtn.setAttribute('aria-label', themeBtn.title);
    }
    if (typeof window.__cmcSetTheme === 'function') {
      window.__cmcSetTheme(currentTheme);
    }
  }

  function toggleTheme() {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    safeSet('cmc_theme', currentTheme);
    applyTheme();
  }

  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  // Apply immediately so the topbar is correct before Phaser mounts,
  // then re-apply once the scene installs __cmcSetTheme so the canvas
  // picks up the same mode.
  applyTheme();
  var attempts = 0;
  var poll = setInterval(function () {
    attempts++;
    if (typeof window.__cmcSetTheme === 'function' || attempts > 40) {
      clearInterval(poll);
      applyTheme();
    }
  }, 100);

  // -------------------------------------------------------------------
  // Settings dialog. App themes are separate from the light/dark chrome mode.
  // -------------------------------------------------------------------

  var settingsBtn = $('settings-btn');
  var settingsOverlay = $('settings-overlay');
  var settingsDialog = $('settings-dialog');
  var settingsClose = $('settings-close');
  var settingsDone = $('settings-done');
  var appThemeSelect = $('app-theme-select');
  var settingsReturnFocus = null;
  var APP_THEME_KEY = 'cmc_app_theme';
  var DEFAULT_APP_THEME = 'space';
  var APP_THEMES = ['space', 'medieval'];

  function normalizeAppTheme(value) {
    return APP_THEMES.indexOf(value) >= 0 ? value : DEFAULT_APP_THEME;
  }

  function applyAppTheme(value) {
    var nextTheme = normalizeAppTheme(value);
    document.body.dataset.appTheme = nextTheme;
    if (appThemeSelect && appThemeSelect.value !== nextTheme) appThemeSelect.value = nextTheme;
    safeSet(APP_THEME_KEY, nextTheme);
    if (typeof window.__cmcSetAppTheme === 'function') {
      window.__cmcSetAppTheme(nextTheme);
    }
  }

  function openSettings(returnFocus) {
    if (!settingsOverlay) return;
    settingsReturnFocus = returnFocus || document.activeElement;
    applyAppTheme(safeGet(APP_THEME_KEY));
    settingsOverlay.classList.add('visible');
    settingsOverlay.setAttribute('aria-hidden', 'false');
    var focusTarget = appThemeSelect || settingsDialog;
    if (focusTarget && focusTarget.focus) focusTarget.focus();
  }

  function closeSettings() {
    if (!settingsOverlay) return;
    settingsOverlay.classList.remove('visible');
    settingsOverlay.setAttribute('aria-hidden', 'true');
    if (settingsReturnFocus && settingsReturnFocus.focus) settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }

  applyAppTheme(safeGet(APP_THEME_KEY));

  if (settingsBtn) settingsBtn.addEventListener('click', function () { openSettings(settingsBtn); });
  if (settingsClose) settingsClose.addEventListener('click', closeSettings);
  if (settingsDone) settingsDone.addEventListener('click', closeSettings);
  if (appThemeSelect) appThemeSelect.addEventListener('change', function () { applyAppTheme(appThemeSelect.value); });
  var appThemeAttempts = 0;
  var appThemePoll = setInterval(function () {
    appThemeAttempts++;
    if (typeof window.__cmcSetAppTheme === 'function' || appThemeAttempts > 40) {
      clearInterval(appThemePoll);
      applyAppTheme(safeGet(APP_THEME_KEY));
    }
  }, 100);
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', function (event) {
      if (event.target === settingsOverlay) closeSettings();
    });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && settingsOverlay && settingsOverlay.classList.contains('visible')) {
      closeSettings();
    }
  });

  // -------------------------------------------------------------------
  // Active model chip in the topbar. The scene calls this whenever the
  // selected session changes OR when its `last_model` value changes
  // between scans (so mid-session model switches surface immediately).
  // Pass an empty string to hide the chip — used on scene shutdown and
  // when no session has emitted a model-bearing event yet.
  // -------------------------------------------------------------------

  var modelEl = $('model-chip');
  var resetBtn = $('reset-btn');
  var lastModel = '';

  window.__cmcUpdateModel = function (model) {
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

  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      if (typeof window.__cmcResetActivityStats === 'function') {
        window.__cmcResetActivityStats();
      }
    });
  }

  // -------------------------------------------------------------------
  // HTML Inspector overlay. Phaser owns the map; this DOM view owns the
  // dense drill-down so native scrolling/wrapping/keyboard close work
  // like a normal desktop dialog.
  // -------------------------------------------------------------------

  var inspectorOverlay = $('inspector-overlay');
  var inspectorTitle = $('inspector-title');
  var inspectorSubtitle = $('inspector-subtitle');
  var inspectorClose = $('inspector-close');
  var inspectorToolbar = inspectorOverlay && inspectorOverlay.querySelector('.inspector-toolbar');
  var inspectorTabs = $('inspector-tabs');
  var inspectorList = $('inspector-list');
  var inspectorDetail = $('inspector-detail');
  var inspectorSession = null;
  var inspectorScope = 'session';
  var sectorInspectorContext = null;
  var inspectorMode = 'tools';
  var inspectorTab = 'all';
  var selectedToolKey = '';
  var selectedTurnId = '';
  var inspectorReturnFocus = null;
  var rawRevealState = null;

  var TOOL_TABS = [
    { id: 'all', label: 'All' },
    { id: 'mcp', label: 'MCP' },
    { id: 'hooks', label: 'Hooks' },
    { id: 'skills', label: 'Skills' },
    { id: 'delegates', label: 'Sub-agents' },
    { id: 'failures', label: 'Failures' },
  ];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatClock(iso) {
    var d = new Date(iso || '');
    if (Number.isNaN(d.getTime())) return '';
    return [
      String(d.getHours()).padStart(2, '0'),
      String(d.getMinutes()).padStart(2, '0'),
      String(d.getSeconds()).padStart(2, '0'),
    ].join(':');
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0ms';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return s === 0 ? m + 'm' : m + 'm' + s + 's';
  }

  function compactNumber(value) {
    var n = Number(value || 0);
    if (n >= 1000000) return Math.round(n / 1000000) + 'm';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  function toolKey(call) {
    return call && (call.event_ref || call.call_id || [call.timestamp, call.tool, call.category].join('|'));
  }

  function callKindLabel(call) {
    var category = call && call.category;
    if (category === 'mcp') return 'MCP tool';
    if (category === 'skills') return 'Skill';
    if (category === 'delegates') return 'Sub-agent';
    if (category === 'terminal') return 'Command';
    if (category === 'signal') return 'Web/docs';
    if (category === 'hooks') return 'Hook';
    if (category === 'forge') return 'Edit';
    if (category === 'library') return 'Read/search';
    if (category === 'court') return 'Control';
    return category || 'Tool';
  }

  function truncateText(value, max) {
    var text = String(value == null ? '' : value);
    if (text.length <= max) return text;
    if (max <= 3) return '.'.repeat(Math.max(0, max));
    return text.slice(0, max - 3) + '...';
  }

  function toolDisplayName(call) {
    var tool = (call && call.tool) || 'tool';
    var target = call && call.target;
    return target && target !== tool ? tool + ' -> ' + target : tool;
  }

  function callStatusMeta(call) {
    if (!call) return 'unknown';
    if (!call.success) return 'failed';
    return typeof call.duration_ms === 'number' ? formatDuration(call.duration_ms) : 'in flight';
  }

  function callDetailLine(call) {
    var parts = [callKindLabel(call), call && call.success ? 'success' : 'failed'];
    if (call && typeof call.duration_ms === 'number') parts.push(formatDuration(call.duration_ms));
    var clock = call && formatClock(call.timestamp);
    if (clock) parts.push(clock);
    if (call && call.model) parts.push(call.model);
    (call && call.details || []).forEach(function (detail) {
      if (!detail || !detail.label || !detail.value) return;
      if (/^(type|provider|privacy)$/i.test(detail.label)) return;
      if (parts.length < 7) parts.push(detail.label + ': ' + detail.value);
    });
    return parts.join(' · ');
  }

  function callsForTurn(turn) {
    return ((inspectorSession && inspectorSession.recent_tool_calls) || [])
      .filter(function (call) { return call.turn_id === turn.id; });
  }

  function turnToolDetailList(turn) {
    var related = callsForTurn(turn);
    if (!related.length) return '';
    var visible = related.slice(0, 8).map(function (call) {
      return truncateText(toolDisplayName(call), 34) + ' (' + callKindLabel(call) + ' · ' + callStatusMeta(call) + ')';
    }).join(', ');
    return visible + (related.length > 8 ? ' +' + (related.length - 8) + ' more' : '');
  }

  function turnDurationLabel(turn) {
    if (typeof turn.duration_ms === 'number') return formatDuration(turn.duration_ms);
    if (turn.status === 'running') return 'running';
    return 'unknown';
  }

  function filteredCalls() {
    var calls = ((inspectorSession && inspectorSession.recent_tool_calls) || []).slice().reverse();
    if (inspectorScope === 'sector' && sectorInspectorContext) {
      return calls.filter(function (call) { return call.category === sectorInspectorContext.category; });
    }
    if (inspectorTab === 'all') return calls;
    if (inspectorTab === 'failures') return calls.filter(function (call) { return !call.success; });
    return calls.filter(function (call) { return call.category === inspectorTab; });
  }

  function recentTurns() {
    return ((inspectorSession && inspectorSession.recent_turns) || []).slice().reverse();
  }

  function selectedCall(calls) {
    if (!calls.length) return null;
    return calls.find(function (call) { return toolKey(call) === selectedToolKey; }) || calls[0];
  }

  function selectedTurn(turns) {
    if (!turns.length) return null;
    return turns.find(function (turn) { return turn.id === selectedTurnId; }) || turns[0];
  }

  function turnToolList(turn) {
    var names = (turn.tools || []).filter(Boolean);
    if (!names.length) {
      names = ((inspectorSession && inspectorSession.recent_tool_calls) || [])
        .filter(function (call) { return call.turn_id === turn.id; })
        .map(toolDisplayName);
    }
    if (!names.length) return 'none retained';
    var visible = names.slice(0, 8).map(function (name) { return truncateText(name, 48); }).join(', ');
    return visible + (names.length > 8 ? ' +' + (names.length - 8) + ' more' : '');
  }

  function turnToolTotal(turn, related) {
    var counted = Number(turn.tool_count || 0);
    return Math.max(Number.isFinite(counted) ? counted : 0, (turn.tools || []).length, related.length);
  }

  function kvRows(rows) {
    return '<dl class="inspector-kv">' + rows.map(function (row) {
      return '<dt>' + escapeHtml(row[0]) + '</dt><dd>' + escapeHtml(row[1]) + '</dd>';
    }).join('') + '</dl>';
  }

  function activeRevealState(call) {
    var key = toolKey(call);
    return rawRevealState && rawRevealState.key === key ? rawRevealState : null;
  }

  function revealArgsText(state) {
    if (!state || state.status !== 'ready') return 'hidden by privacy boundary';
    return state.details && state.details.raw_args ? state.details.raw_args : 'not available in the retained event';
  }

  function revealOutputText(state) {
    if (!state || state.status !== 'ready') return 'hidden by privacy boundary';
    return state.details && state.details.raw_output ? state.details.raw_output : 'not retained by provider schema';
  }

  function hasRawDetailPayload(details) {
    return !!(details && (details.raw_args || details.raw_output));
  }

  function renderRevealPanel(call, state) {
    if (!call.event_ref) return '';
    if (state && state.status === 'ready' && !hasRawDetailPayload(state.details)) {
      return '<div class="inspector-reveal"><div class="inspector-empty">No raw local details were retained for this call.</div></div>';
    }
    var buttonLabel = state && state.status === 'ready' ? 'Refresh raw local details' : 'Reveal raw local details';
    var disabled = state && state.status === 'loading';
    var status = '';
    if (state && state.status === 'loading') {
      status = '<div class="inspector-empty">Loading raw local details...</div>';
    } else if (state && state.status === 'error') {
      status = '<div class="inspector-empty">Reveal failed: ' + escapeHtml(state.error || 'unknown error') + '</div>';
    } else if (state && state.status === 'ready') {
      status = '<div class="inspector-empty">Raw local details are visible for this selected call only.</div>';
    }
    return '<div class="inspector-reveal">'
      + '<div class="inspector-reveal-warning">Raw local details may include prompts, file paths, file contents, secrets, or command output from this machine.</div>'
      + '<button class="cmc-button accent" type="button" data-inspector-reveal ' + (disabled ? 'disabled aria-disabled="true"' : '') + '>' + escapeHtml(buttonLabel) + '</button>'
      + status
      + '</div>';
  }

  function renderTabs() {
    if (!inspectorTabs) return;
    if (inspectorScope === 'sector' || inspectorMode !== 'tools') {
      inspectorTabs.innerHTML = '';
      inspectorTabs.hidden = true;
      return;
    }
    inspectorTabs.hidden = false;
    inspectorTabs.innerHTML = TOOL_TABS.map(function (tab) {
      var active = inspectorTab === tab.id;
      return '<button class="inspector-pill ' + (active ? 'active' : '') + '" type="button" data-inspector-tab="' + tab.id + '" aria-pressed="' + (active ? 'true' : 'false') + '">' + escapeHtml(tab.label) + '</button>';
    }).join('');
  }

  function renderToolList(calls, selected) {
    if (!inspectorList) return;
    if (!calls.length) {
      if (inspectorScope === 'sector' && sectorInspectorContext) {
        var total = Number(sectorInspectorContext.count || 0);
        var sector = sectorInspectorContext.title || categoryLabel(sectorInspectorContext.category);
        var message = total > 0
          ? 'This sector recorded ' + exactNumber(total) + ' selected-session signals, but no detailed rows are in the retained call window.'
          : 'No retained rows for the selected ' + sector + ' sector.';
        inspectorList.innerHTML = '<div class="inspector-empty">' + escapeHtml(message) + '</div>';
        return;
      }
      inspectorList.innerHTML = '<div class="inspector-empty">No ' + escapeHtml(inspectorTab) + ' calls retained for this session.</div>';
      return;
    }
    inspectorList.innerHTML = calls.map(function (call) {
      var key = toolKey(call);
      var active = selected && toolKey(selected) === key;
      var duration = typeof call.duration_ms === 'number' ? formatDuration(call.duration_ms) : 'in flight';
      var fullName = toolDisplayName(call);
      return '<button class="inspector-row ' + (active ? 'active ' : '') + (!call.success ? 'failed' : '') + '" type="button" data-tool-key="' + escapeHtml(key) + '">'
        + '<span class="inspector-dot"></span>'
        + '<span class="inspector-row-main"><span class="inspector-row-title" title="' + escapeHtml(fullName) + '">' + escapeHtml(truncateText(fullName, 48)) + '</span>'
        + '<span class="inspector-row-sub">' + escapeHtml(callKindLabel(call)) + ' · ' + escapeHtml(call.turn_id || 'no turn') + '</span></span>'
        + '<span class="inspector-row-meta">' + escapeHtml(duration) + '<br>' + escapeHtml(formatClock(call.timestamp)) + '</span>'
        + '</button>';
    }).join('');
  }

  function renderToolDetail(call) {
    if (!inspectorDetail) return;
    if (!call) {
      if (inspectorScope === 'sector' && sectorInspectorContext) {
        var total = Number(sectorInspectorContext.count || 0);
        inspectorDetail.innerHTML = '<h3>Sector details</h3>' + kvRows([
          ['Sector', sectorInspectorContext.title || categoryLabel(sectorInspectorContext.category)],
          ['Signals', exactNumber(total)],
          ['Retained rows', '0'],
        ]) + '<div class="inspector-empty">Select a retained row when one is available.</div>';
        return;
      }
      inspectorDetail.innerHTML = '<h3>Safe details</h3><div class="inspector-empty">Select a tool call to inspect.</div>';
      return;
    }
    var turn = ((inspectorSession && inspectorSession.recent_turns) || []).find(function (t) { return t.id === call.turn_id; });
    var rows = [
      ['Tool', call.tool || 'tool'],
      ['Category', callKindLabel(call)],
      ['Status', call.success ? 'success' : 'failed'],
      ['Started', (formatClock(call.timestamp) || 'unknown') + ' · ' + (call.timestamp || 'unknown')],
      ['Duration', typeof call.duration_ms === 'number' ? formatDuration(call.duration_ms) : 'in flight'],
      ['Turn', call.turn_id || 'not attributed'],
      ['Model', call.model || (turn && turn.model) || 'unknown'],
      ['Call ref', call.call_id || 'not available'],
    ];
    if (turn) rows.push(['Turn status', turn.status + (turn.partial ? ' · partial tail window' : '')]);
    (call.details || []).forEach(function (detail) { rows.push([detail.label, detail.value]); });
    var revealState = activeRevealState(call);
    rows.push(['Raw args', revealArgsText(revealState)]);
    rows.push(['Output', revealOutputText(revealState)]);
    inspectorDetail.innerHTML = '<h3>Safe details</h3>' + kvRows(rows) + renderRevealPanel(call, revealState);
  }

  function renderTurnList(turns, selected) {
    if (!inspectorList) return;
    if (!turns.length) {
      inspectorList.innerHTML = '<div class="inspector-empty">No turn summaries retained for this session.</div>';
      return;
    }
    inspectorList.innerHTML = turns.map(function (turn) {
      var active = selected && selected.id === turn.id;
      var failed = Number(turn.failure_count || 0) > 0;
      var partial = turn.partial ? 'partial - ' : '';
      return '<button class="inspector-row ' + (active ? 'active ' : '') + (failed ? 'failed' : '') + '" type="button" data-turn-id="' + escapeHtml(turn.id) + '">'
        + '<span class="inspector-dot"></span>'
        + '<span class="inspector-row-main"><span class="inspector-row-title">' + escapeHtml(partial + (turn.status || 'turn') + ' · ' + (turn.tool_count || 0) + ' tools') + '</span>'
        + '<span class="inspector-row-sub">' + escapeHtml((turn.categories || []).join(', ') || 'no tools') + ' · ' + escapeHtml(compactNumber(turn.output_tokens || 0)) + ' out</span></span>'
        + '<span class="inspector-row-meta">' + escapeHtml(turnDurationLabel(turn)) + '<br>' + escapeHtml(formatClock(turn.started_at)) + '</span>'
        + '</button>';
    }).join('');
  }

  function renderTurnDetail(turn) {
    if (!inspectorDetail) return;
    if (!turn) {
      inspectorDetail.innerHTML = '<h3>Turn story</h3><div class="inspector-empty">Select a turn to inspect.</div>';
      return;
    }
    var related = callsForTurn(turn).slice().reverse();
    var totalTools = turnToolTotal(turn, related);
    var ranTools = turnToolList(turn);
    var toolDetails = turnToolDetailList(turn);
    var rows = [
      ['Status', (turn.status || 'unknown') + (turn.partial ? ' · partial tail window' : '')],
      ['Started', (formatClock(turn.started_at) || 'unknown') + ' · ' + (turn.started_at || 'unknown')],
      ['Duration', turnDurationLabel(turn)],
      ['Tools', String(totalTools)],
      ['Ran', ranTools],
      ['Tool details', toolDetails || 'none retained'],
      ['Failures', String(turn.failure_count || 0)],
      ['Categories', (turn.categories || []).join(', ') || 'none'],
      ['Model', turn.model || 'unknown'],
      ['Output', compactNumber(turn.output_tokens || 0) + ' tokens'],
    ];
    var missingToolNames = ranTools && ranTools !== 'none retained' ? ' (' + escapeHtml(ranTools) + ')' : '';
    var emptyRelated = totalTools > 0
      ? 'This turn recorded ' + totalTools + ' tools' + missingToolNames + ', but no detailed rows are in the retained call window.'
      : 'No tool rows in the retained call window.';
    var relatedHtml = related.length
      ? '<div class="inspector-related">' + related.slice(0, 12).map(function (call) {
          var fullName = toolDisplayName(call);
          return '<div class="inspector-related-item ' + (!call.success ? 'failed' : '') + '">'
            + '<span class="inspector-related-main">'
            + '<span class="inspector-related-name" title="' + escapeHtml(fullName) + '">' + escapeHtml(truncateText(fullName, 48)) + '</span>'
            + '<span class="inspector-related-sub">' + escapeHtml(callDetailLine(call)) + '</span>'
            + '</span>'
            + '<span class="inspector-related-meta">' + escapeHtml(callStatusMeta(call)) + '</span>'
            + '</div>';
        }).join('') + '</div>'
      : '<div class="inspector-empty">' + emptyRelated + '</div>';
    inspectorDetail.innerHTML = '<h3>Turn story</h3>' + kvRows(rows)
      + '<div class="inspector-related-title">Retained tool rows (' + related.length + ' of ' + totalTools + ')</div>'
      + relatedHtml;
  }

  function renderInspector() {
    if (!inspectorSession) return;
    var sectorCalls = inspectorScope === 'sector' ? filteredCalls() : null;
    if (inspectorToolbar) inspectorToolbar.hidden = inspectorScope === 'sector';
    if (inspectorScope === 'sector' && sectorInspectorContext) {
      if (inspectorTitle) {
        inspectorTitle.innerHTML = '<span class="inspector-title-swatch" style="--swatch:' + escapeHtml(sectorInspectorContext.color || CATEGORY_COLORS[sectorInspectorContext.category] || '#ffd54a') + '"></span>'
          + escapeHtml((sectorInspectorContext.title || categoryLabel(sectorInspectorContext.category)) + ' details · ' + (inspectorSession.title || inspectorSession.id || 'session'));
      }
      if (inspectorSubtitle) {
        var retained = sectorCalls ? sectorCalls.length : 0;
        var total = Number(sectorInspectorContext.count || 0);
        inspectorSubtitle.textContent = (inspectorSession.repository || 'unknown repo') + ' / ' + (inspectorSession.branch || 'unknown')
          + ' · ' + retained + ' retained rows · ' + exactNumber(total) + ' selected-session signals';
      }
    } else {
      if (inspectorTitle) inspectorTitle.textContent = 'Inspector · ' + (inspectorSession.title || inspectorSession.id || 'session');
      if (inspectorSubtitle) {
        var calls = (inspectorSession.recent_tool_calls || []).length;
        var turns = (inspectorSession.recent_turns || []).length;
        inspectorSubtitle.textContent = (inspectorSession.repository || 'unknown repo') + ' / ' + (inspectorSession.branch || 'unknown') + ' · ' + calls + ' calls · ' + turns + ' turns';
      }
    }
    if (inspectorScope !== 'sector') {
      document.querySelectorAll('[data-inspector-mode]').forEach(function (btn) {
        var active = btn.getAttribute('data-inspector-mode') === inspectorMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }
    renderTabs();
    if (inspectorScope === 'sector') {
      var sectorCall = selectedCall(sectorCalls || []);
      selectedToolKey = sectorCall ? toolKey(sectorCall) : '';
      renderToolList(sectorCalls || [], sectorCall);
      renderToolDetail(sectorCall);
      return;
    }
    if (inspectorMode === 'tools') {
      var callsForTab = filteredCalls();
      var call = selectedCall(callsForTab);
      selectedToolKey = call ? toolKey(call) : '';
      renderToolList(callsForTab, call);
      renderToolDetail(call);
    } else {
      var turns = recentTurns();
      var turn = selectedTurn(turns);
      selectedTurnId = turn ? turn.id : '';
      renderTurnList(turns, turn);
      renderTurnDetail(turn);
    }
  }

  function focusableInspectorElements() {
    if (!inspectorOverlay) return [];
    return Array.prototype.slice.call(inspectorOverlay.querySelectorAll('button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(function (el) {
        var style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
  }

  function restoreInspectorFocus() {
    var target = inspectorReturnFocus && document.contains(inspectorReturnFocus)
      ? inspectorReturnFocus
      : document.querySelector(inspectorScope === 'sector' ? '#dom-quarter [data-cmc-action="quarter-details"]' : '#dom-session [data-cmc-action="inspector"]');
    inspectorReturnFocus = null;
    if (target && typeof target.focus === 'function' && !target.disabled) {
      setTimeout(function () { target.focus(); }, 0);
    }
  }

  function openInspector(session, trigger) {
    if (!inspectorOverlay || !session) return false;
    inspectorReturnFocus = trigger || document.activeElement;
    inspectorSession = session;
    inspectorScope = 'session';
    sectorInspectorContext = null;
    inspectorMode = 'tools';
    inspectorTab = 'all';
    selectedToolKey = '';
    selectedTurnId = '';
    rawRevealState = null;
    inspectorOverlay.classList.add('visible');
    inspectorOverlay.setAttribute('aria-hidden', 'false');
    renderInspector();
    setTimeout(function () {
      var first = focusableInspectorElements()[0];
      if (first) first.focus();
      else if (inspectorList) inspectorList.focus();
    }, 0);
    return true;
  }

  function openSectorInspector(session, sector, trigger) {
    if (!inspectorOverlay || !session || !sector || !sector.category) return false;
    inspectorReturnFocus = trigger || document.activeElement;
    inspectorSession = session;
    inspectorScope = 'sector';
    sectorInspectorContext = {
      category: sector.category,
      title: sector.title || categoryLabel(sector.category),
      count: Number(sector.count || 0),
      color: sector.color || CATEGORY_COLORS[sector.category] || '#ffd54a',
    };
    inspectorMode = 'tools';
    inspectorTab = sectorInspectorContext.category;
    selectedToolKey = '';
    selectedTurnId = '';
    rawRevealState = null;
    inspectorOverlay.classList.add('visible');
    inspectorOverlay.setAttribute('aria-hidden', 'false');
    renderInspector();
    setTimeout(function () {
      var first = focusableInspectorElements()[0];
      if (first) first.focus();
      else if (inspectorList) inspectorList.focus();
    }, 0);
    return true;
  }

  function closeInspector() {
    if (!inspectorOverlay) return;
    var wasOpen = inspectorOverlay.classList.contains('visible');
    inspectorOverlay.classList.remove('visible');
    inspectorOverlay.setAttribute('aria-hidden', 'true');
    rawRevealState = null;
    if (wasOpen) restoreInspectorFocus();
    sectorInspectorContext = null;
    inspectorScope = 'session';
  }

  function tauriInvoke() {
    var internalInvoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof internalInvoke === 'function') return internalInvoke.bind(window.__TAURI_INTERNALS__);
    var coreInvoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (typeof coreInvoke === 'function') return coreInvoke.bind(window.__TAURI__.core);
    return null;
  }

  function revealRawDetails(call) {
    if (!call || !call.event_ref || !inspectorSession) return;
    var invoke = tauriInvoke();
    var key = toolKey(call);
    if (!invoke) {
      rawRevealState = { key: key, status: 'error', error: 'Raw local details require the Tauri app.' };
      renderToolDetail(call);
      return;
    }
    rawRevealState = { key: key, status: 'loading' };
    renderToolDetail(call);
    invoke('get_raw_tool_call_details', {
      provider: inspectorSession.provider || 'copilot',
      sessionId: inspectorSession.id,
      eventRef: call.event_ref,
    }).then(function (details) {
      if (!inspectorOverlay || !inspectorOverlay.classList.contains('visible')) return;
      rawRevealState = { key: key, status: 'ready', details: details || {} };
      renderToolDetail(call);
    }).catch(function (err) {
      if (!inspectorOverlay || !inspectorOverlay.classList.contains('visible')) return;
      rawRevealState = { key: key, status: 'error', error: err && err.message ? err.message : String(err || 'unknown error') };
      renderToolDetail(call);
    });
  }

  window.__cmcOpenInspector = openInspector;
  window.__cmcOpenSectorInspector = openSectorInspector;
  window.__cmcCloseInspector = closeInspector;

  if (inspectorClose) inspectorClose.addEventListener('click', closeInspector);
  if (inspectorOverlay) {
    inspectorOverlay.addEventListener('click', function (event) {
      if (event.target === inspectorOverlay) closeInspector();
    });
  }
  document.addEventListener('keydown', function (event) {
    if (!inspectorOverlay || !inspectorOverlay.classList.contains('visible')) return;
    if (event.key === 'Escape') {
      closeInspector();
      return;
    }
    if (event.key === 'Tab') {
      var focusable = focusableInspectorElements();
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var modeBtn = target.closest('[data-inspector-mode]');
    if (modeBtn) {
      inspectorMode = modeBtn.getAttribute('data-inspector-mode') || 'tools';
      rawRevealState = null;
      renderInspector();
      return;
    }
    var tabBtn = target.closest('[data-inspector-tab]');
    if (tabBtn) {
      inspectorTab = tabBtn.getAttribute('data-inspector-tab') || 'all';
      selectedToolKey = '';
      rawRevealState = null;
      renderInspector();
      return;
    }
    var toolBtn = target.closest('[data-tool-key]');
    if (toolBtn) {
      selectedToolKey = toolBtn.getAttribute('data-tool-key') || '';
      rawRevealState = null;
      renderInspector();
      return;
    }
    var revealBtn = target.closest('[data-inspector-reveal]');
    if (revealBtn) {
      var call = selectedCall(filteredCalls());
      revealRawDetails(call);
      return;
    }
    var turnBtn = target.closest('[data-turn-id]');
    if (turnBtn) {
      selectedTurnId = turnBtn.getAttribute('data-turn-id') || '';
      renderInspector();
    }
  });

  // -------------------------------------------------------------------
  // HTML dashboard panels. Phaser now renders only the central sector
  // map/castle/pulses; all data-heavy chrome is regular DOM.
  // -------------------------------------------------------------------

  var domSession = $('dom-session');
  var domFeed = $('dom-feed');
  var domQuarter = $('dom-quarter');
  var domReplay = $('dom-replay');
  var domLoading = $('dashboard-loading');
  var domLoadingImage = domLoading ? domLoading.querySelector('img') : null;
  var schemaDriftOverlay = $('schema-drift-overlay');
  var schemaDriftSubtitle = $('schema-drift-subtitle');
  var schemaDriftBody = $('schema-drift-body');
  var schemaDriftClose = $('schema-drift-close');
  var schemaDriftDismiss = $('schema-drift-dismiss');
  var schemaDriftReport = $('schema-drift-report');
  var lastDashboard = null;
  var activeSchemaDriftReport = null;
  var lastSchemaDriftFingerprint = '';
  var DASHBOARD_SPLASH_MIN_MS = Number.isFinite(Number(window.__cmcSplashMinMs))
    ? Math.max(0, Number(window.__cmcSplashMinMs))
    : 2000;
  var dashboardSplashVisibleAt = nowMs();
  var dashboardSplashImageSettled = !domLoadingImage || domLoadingImage.complete;
  var dashboardSplashHideRequested = false;
  var dashboardSplashTimer = 0;
  var liveFingerprints = {
    session: '',
    feed: '',
    quarter: '',
    replay: '',
  };

  function nowMs() {
    return window.performance && typeof window.performance.now === 'function'
      ? window.performance.now()
      : Date.now();
  }

  function hideDashboardSplash() {
    dashboardSplashTimer = 0;
    document.body.classList.add('dashboard-splash-hidden');
    if (domLoading) domLoading.setAttribute('aria-hidden', 'true');
  }

  function scheduleDashboardSplashHide() {
    if (!dashboardSplashHideRequested || !dashboardSplashImageSettled) return;
    if (document.body.classList.contains('dashboard-splash-hidden')) return;
    var delay = Math.max(0, DASHBOARD_SPLASH_MIN_MS - (nowMs() - dashboardSplashVisibleAt));
    if (dashboardSplashTimer) window.clearTimeout(dashboardSplashTimer);
    if (delay > 0) {
      dashboardSplashTimer = window.setTimeout(hideDashboardSplash, delay);
    } else {
      hideDashboardSplash();
    }
  }

  function requestDashboardSplashHide() {
    dashboardSplashHideRequested = true;
    scheduleDashboardSplashHide();
  }

  if (domLoadingImage && !domLoadingImage.complete) {
    var settleDashboardSplashImage = function () {
      dashboardSplashImageSettled = true;
      dashboardSplashVisibleAt = nowMs();
      scheduleDashboardSplashHide();
    };
    domLoadingImage.addEventListener('load', settleDashboardSplashImage, { once: true });
    domLoadingImage.addEventListener('error', settleDashboardSplashImage, { once: true });
  }

  var CATEGORY_COLORS = {
    forge: '#f0911d',
    library: '#e1ae45',
    terminal: '#86d4b7',
    signal: '#c37ee8',
    hooks: '#61d6ff',
    delegates: '#fc60c7',
    skills: '#da58e0',
    court: '#2fc5e8',
    mcp: '#45cea5',
    alert: '#ff5252',
  };

  var CATEGORY_LABELS = {
    forge: 'Edits',
    library: 'Reads',
    terminal: 'Commands',
    signal: 'Web/Docs',
    hooks: 'Hooks',
    delegates: 'Sub-Agents',
    skills: 'Skills',
    court: 'Intent',
    mcp: 'MCP',
    alert: 'Failures',
  };

  function categoryLabel(category) {
    return CATEGORY_LABELS[category] || category || 'Sector';
  }

  function setPanelRect(el, rect) {
    if (!el || !rect) return;
    el.style.left = Math.round(rect.x) + 'px';
    el.style.top = Math.round(rect.y) + 'px';
    el.style.width = Math.round(rect.w) + 'px';
    el.style.height = Number.isFinite(rect.h) ? Math.round(rect.h) + 'px' : 'auto';
  }

  function panelBody(el) {
    return el && el.querySelector('.cmc-panel-body');
  }

  function eventLabel(kind, category) {
    if (!kind && !category) return 'none';
    if (kind === 'tool.execution_start') return 'tool started';
    if (kind === 'tool.execution_complete') return category === 'alert' ? 'tool failed' : 'tool completed';
    if (kind === 'hook.start') return 'hook started';
    if (kind === 'hook.end') return category === 'alert' ? 'hook failed' : 'hook completed';
    if (kind === 'assistant.turn_start') return 'thinking started';
    if (kind === 'assistant.turn_end') return 'waiting';
    if (kind === 'user.message') return 'prompt received';
    if (kind === 'session.start') return 'session opened';
    return kind || 'activity';
  }

  function compactNumberShort(value) {
    var n = Number(value || 0);
    if (n >= 1000000) return Math.round(n / 1000000) + 'm';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

  function exactNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function tokenLabel(input, output) {
    var inTok = Number(input || 0);
    var outTok = Number(output || 0);
    return exactNumber(inTok) + ' / ' + exactNumber(outTok);
  }

  function ageLabel(seconds) {
    if (seconds == null || Number.isNaN(Number(seconds))) return 'unknown';
    var n = Math.max(0, Number(seconds));
    if (n < 60) return Math.floor(n) + 's';
    if (n < 3600) return Math.floor(n / 60) + 'm';
    return Math.floor(n / 3600) + 'h';
  }

  function ageFromIso(iso) {
    var ts = Date.parse(iso || '');
    if (Number.isNaN(ts)) return null;
    return ageLabel((Date.now() - ts) / 1000);
  }

  function latestCall(calls) {
    return (calls || []).filter(function (call) {
      return call && call.tool !== 'report_intent';
    }).reduce(function (latest, call) {
      var ts = Date.parse(call.completed_at || call.timestamp || '');
      if (Number.isNaN(ts)) return latest;
      if (!latest || ts > latest.ts) return { call: call, ts: ts };
      return latest;
    }, null);
  }

  function selectedActivity(session) {
    var latest = latestCall(session && session.recent_tool_calls);
    if (latest) {
      var call = latest.call;
      var state = call.success ? (call.completed_at ? 'completed' : 'running') : 'failed';
      return {
        last: (call.tool || 'tool') + ' ' + state,
        tool: call.tool || session.last_tool || 'none',
        age: ageLabel((Date.now() - latest.ts) / 1000),
      };
    }
    var lifecycle = /^(session\.shutdown|session\.compaction_complete)$/;
    var kind = session && session.last_event_kind;
    var last = kind && !lifecycle.test(kind)
      ? eventLabel(kind, session.last_event_category)
      : (session && session.last_tool) || 'activity';
    return {
      last: last,
      tool: (session && session.last_tool) || 'none',
      age: ageFromIso(session && (session.last_event_timestamp || session.updated_at)) || ageLabel(session && session.stale_seconds),
    };
  }

  function sessionOptionLines(opt) {
    var marker = opt && opt.isActive ? '● ' : '○ ';
    var shortId = (opt && (opt.shortId || (opt.id || '').slice(0, 8))) || '';
    var sessionName = opt && opt.sessionName;
    if (sessionName) {
      return {
        main: marker + (opt.repository || opt.title || opt.id || 'session'),
        sub: sessionName + (shortId ? ' · ' + shortId : ''),
      };
    }
    return {
      main: marker + ((opt && (opt.title || opt.id)) || 'session') + (shortId ? ' · ' + shortId : ''),
      sub: '',
    };
  }

  function renderSessionOption(opt) {
    var lines = sessionOptionLines(opt || {});
    return '<span class="cmc-session-option-text">'
      + '<span class="cmc-session-option-main">' + escapeHtml(lines.main) + '</span>'
      + (lines.sub ? '<span class="cmc-session-option-sub">' + escapeHtml(lines.sub) + '</span>' : '')
      + '</span>';
  }

  function selectedSessionHeading(session) {
    if (!session) return { title: '', subtitle: '' };
    if (session.session_name) {
      return {
        title: session.repository || session.title || session.id,
        subtitle: session.session_name,
      };
    }
    return { title: session.title || session.id, subtitle: '' };
  }

  function closeSessionMenu() {
    document.querySelectorAll('.cmc-session-picker.open').forEach(function (picker) {
      picker.classList.remove('open');
      var trigger = picker.querySelector('[data-cmc-action="session-menu"]');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleSessionMenu(trigger) {
    var picker = trigger && trigger.closest('.cmc-session-picker');
    if (!picker) return;
    var isOpen = picker.classList.contains('open');
    closeSessionMenu();
    if (!isOpen) {
      picker.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
    }
  }

  function restoreSessionMenuIfNeeded(body, shouldOpen) {
    if (!shouldOpen) return;
    var picker = body.querySelector('.cmc-session-picker');
    var trigger = picker && picker.querySelector('[data-cmc-action="session-menu"]');
    if (!picker || !trigger) return;
    picker.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
  }

  function renderSession(view) {
    var body = panelBody(domSession);
    if (!body) return;
    var keepMenuOpen = !!body.querySelector('.cmc-session-picker.open');
    var selected = view.sessions && view.sessions.selected;
    var options = (view.sessions && view.sessions.options) || [];
    var alerts = (view.providerAlerts || []).slice(0, 3);
    var alertsHtml = alerts.length
      ? alerts.map(function (alert) {
          return '<div class="cmc-provider-alert">' + escapeHtml(alert) + '</div>';
        }).join('')
      : '';
    if (!options.length) {
      body.innerHTML = alertsHtml + '<div class="cmc-label">No running Copilot sessions found. Start Copilot CLI and this panel will show the active task.</div>';
      return;
    }
    var selectedId = selected && selected.id;
    var selectedOption = options.find(function (opt) { return opt.id === selectedId; }) || options[0];
    var picker = '<div class="cmc-label" style="margin-bottom:8px">' + escapeHtml(view.sessions.header || '') + '</div>'
      + '<div class="cmc-session-picker">'
      + '<button class="cmc-session-trigger" type="button" data-cmc-action="session-menu" aria-haspopup="listbox" aria-expanded="false">'
      + renderSessionOption(selectedOption)
      + '<span class="cmc-session-caret" aria-hidden="true">▾</span>'
      + '</button>'
      + '<div class="cmc-session-menu" role="listbox" aria-label="Select Copilot session">'
      + options.map(function (opt) {
        return '<button class="cmc-session-option ' + (opt.id === selectedId ? 'selected' : '') + '" type="button" role="option" aria-selected="' + (opt.id === selectedId ? 'true' : 'false') + '" data-session-id="' + escapeHtml(opt.id) + '">'
          + renderSessionOption(opt)
          + '</button>';
      }).join('')
      + '</div></div>';
    var selectedHtml = '';
    if (selected) {
      var inTok = selected.input_tokens || 0;
      var outTok = selected.output_tokens || 0;
      var tcalls = (selected.recent_tool_calls || []).length;
      var hasGitRoot = !!selected.git_root;
      var activity = selected.replay_activity || selectedActivity(selected);
      var heading = selectedSessionHeading(selected);
      selectedHtml = '<div class="cmc-session-summary">'
        + '<div class="cmc-session-heading">'
        + '<div>'
        + '<div class="cmc-session-title" title="' + escapeHtml(heading.title) + '">' + escapeHtml(heading.title) + '</div>'
        + (heading.subtitle ? '<div class="cmc-session-subtitle" title="' + escapeHtml(heading.subtitle) + '">' + escapeHtml(heading.subtitle) + '</div>' : '')
        + '</div>'
        + '</div>'
        + '<div class="cmc-session-meta">'
        + '<span class="cmc-meta-pill">Last: ' + escapeHtml(activity.last) + '</span>'
        + '<span class="cmc-meta-pill">Tool: ' + escapeHtml(activity.tool) + '</span>'
        + '<span class="cmc-meta-pill">Age: ' + escapeHtml(activity.age) + '</span>'
        + '<span class="cmc-meta-pill">Tokens in/out: ' + tokenLabel(inTok, outTok) + '</span>'
        + '</div>'
        + '</div>'
        + '<div class="cmc-actions">'
        + '<button class="cmc-button accent ' + (hasGitRoot ? '' : 'disabled') + '" aria-label="Open selected session in editor" ' + (hasGitRoot ? 'data-cmc-action="editor"' : 'disabled aria-disabled="true"') + '>↗ Open in Editor</button>'
        + '<button class="cmc-button ' + (tcalls > 0 ? '' : 'disabled') + '" aria-label="Open inspector for selected session" ' + (tcalls > 0 ? 'data-cmc-action="inspector"' : 'disabled aria-disabled="true"') + '>Inspector</button>'
        + '</div>';
    }
    body.innerHTML = alertsHtml + picker + selectedHtml;
    restoreSessionMenuIfNeeded(body, keepMenuOpen);
  }

  function renderFeed(view) {
    if (!domFeed) return;
    var title = domFeed.querySelector('.cmc-panel-title');
    var body = panelBody(domFeed);
    if (title) title.textContent = (view.feed && view.feed.title) || 'Activity Feed';
    if (!body) return;
    var rows = (view.feed && view.feed.rows) || [];
    body.innerHTML = rows.length
      ? '<div class="cmc-feed-list">' + rows.map(function (row) {
          var color = row.success ? (CATEGORY_COLORS[row.category] || '#9aa6c8') : CATEGORY_COLORS.alert;
          return '<div class="cmc-feed-row"><span class="cmc-dot" style="--dot:' + color + '"></span><span>' + escapeHtml(row.label) + '</span><span class="cmc-muted">' + escapeHtml(row.age) + '</span></div>';
        }).join('') + '</div>'
      : '<div class="cmc-label">' + escapeHtml((view.feed && view.feed.empty) || '') + '</div>';
  }

  function renderQuarterData(q) {
    if (!domQuarter) return;
    var title = domQuarter.querySelector('.cmc-panel-title');
    var body = panelBody(domQuarter);
    if (title) title.textContent = q ? q.title : 'Sector';
    if (!body) return;
    if (!q) {
      body.innerHTML = '<div class="cmc-label">No sector activity yet.</div>';
      return;
    }
    domQuarter.style.setProperty('--quarter-color', q.color || CATEGORY_COLORS[q.category] || '#ffd54a');
    var count = Number(q.count || 0);
    var disabled = count <= 0;
    body.innerHTML = '<div class="cmc-quarter-line">' + escapeHtml(q.countLine) + '</div>'
      + '<div class="cmc-quarter-line">' + escapeHtml(q.line) + '</div>'
      + (q.toolList ? '<div class="cmc-quarter-tools cmc-muted">' + escapeHtml(q.toolList) + '</div>' : '')
      + '<div class="cmc-actions cmc-quarter-actions">'
      + '<button class="cmc-button accent ' + (disabled ? 'disabled' : '') + '" type="button" aria-label="Open details for ' + escapeHtml(q.title || categoryLabel(q.category)) + ' sector" aria-haspopup="dialog" '
      + (disabled ? 'disabled aria-disabled="true"' : 'data-cmc-action="quarter-details"')
      + ' data-sector-category="' + escapeHtml(q.category || '') + '"'
      + ' data-sector-title="' + escapeHtml(q.title || categoryLabel(q.category)) + '"'
      + ' data-sector-count="' + escapeHtml(count) + '"'
      + ' data-sector-color="' + escapeHtml(q.color || CATEGORY_COLORS[q.category] || '#ffd54a') + '">Details</button>'
      + '</div>';
  }

  function renderQuarter(view) {
    renderQuarterData(view.quarter);
  }

  function renderReplay(view) {
    if (!domReplay) return;
    var replay = view.replay || { total: 0, cursor: 0, paused: false, atLive: true, status: 'waiting for events' };
    var pct = replay.total > 0 ? Math.max(0, Math.min(100, (replay.cursor / replay.total) * 100)) : 0;
    if (!domReplay.querySelector('.cmc-replay-inner')) {
      domReplay.innerHTML = '<div class="cmc-replay-inner">'
        + '<button class="cmc-button" type="button" data-cmc-action="replay-toggle"></button>'
        + '<div class="cmc-replay-track" data-cmc-action="replay-seek" role="slider" tabindex="0" aria-label="Recent activity replay position" aria-valuemin="0"><div class="cmc-replay-rail"><div class="cmc-replay-fill"></div></div><div class="cmc-replay-knob"></div><div class="cmc-replay-status"></div></div>'
        + '<button class="cmc-button" type="button" data-cmc-action="replay-live"></button>'
        + '</div>';
    }
    var toggle = domReplay.querySelector('[data-cmc-action="replay-toggle"]');
    var live = domReplay.querySelector('[data-cmc-action="replay-live"]');
    var track = domReplay.querySelector('[data-cmc-action="replay-seek"]');
    var fill = domReplay.querySelector('.cmc-replay-fill');
    var knob = domReplay.querySelector('.cmc-replay-knob');
    var status = domReplay.querySelector('.cmc-replay-status');
    if (toggle) {
      toggle.textContent = replay.paused ? '▶' : '⏸';
      toggle.setAttribute('aria-label', replay.paused ? 'Resume recent activity replay' : 'Pause recent activity replay');
    }
    if (live) {
      live.textContent = replay.atLive ? 'LIVE' : 'GO LIVE';
      live.setAttribute('aria-label', replay.atLive ? 'Replay is live' : 'Jump replay to live');
    }
    if (track) {
      track.setAttribute('aria-valuemax', String(replay.total));
      track.setAttribute('aria-valuenow', String(replay.cursor));
      track.setAttribute('aria-valuetext', replay.status);
    }
    if (fill) fill.style.width = pct + '%';
    if (knob) knob.style.left = pct + '%';
    if (status) status.textContent = replay.status;
  }

  function sessionFingerprint(view) {
    var sessions = (view && view.sessions) || {};
    var selected = sessions.selected || {};
    var activity = selected.replay_activity || selectedActivity(selected);
    var options = sessions.options || [];
    return [
      sessions.header || '',
      options.map(function (opt) {
        return [
          opt.id || '',
          opt.title || '',
          opt.sessionName || '',
          opt.repository || '',
          opt.shortId || '',
          opt.isActive ? '1' : '0',
        ].join(':');
      }).join('|'),
      selected.id || '',
      selected.title || '',
      selected.session_name || '',
      selected.repository || '',
      selected.git_root || '',
      selected.input_tokens || 0,
      selected.output_tokens || 0,
      (selected.recent_tool_calls || []).length,
      activity.last || '',
      activity.tool || '',
      activity.age || '',
      (view.providerAlerts || []).join('|'),
    ].join('::');
  }

  function feedFingerprint(view) {
    var feed = (view && view.feed) || {};
    var rows = feed.rows || [];
    return [
      feed.title || '',
      feed.empty || '',
      rows.map(function (row) {
        return [
          row.label || '',
          row.age || '',
          row.category || '',
          row.success ? '1' : '0',
        ].join(':');
      }).join('|'),
    ].join('::');
  }

  function quarterFingerprint(view) {
    var q = view && view.quarter;
    if (!q) return '';
    return [
      q.category || '',
      q.color || '',
      q.title || '',
      q.count || 0,
      q.countLine || '',
      q.line || '',
      q.toolList || '',
    ].join('::');
  }

  function replayFingerprint(view) {
    var replay = (view && view.replay) || {};
    return [
      replay.total || 0,
      replay.cursor || 0,
      replay.paused ? '1' : '0',
      replay.atLive ? '1' : '0',
      replay.status || '',
    ].join('::');
  }

  function updateLiveFingerprints(view) {
    liveFingerprints.session = sessionFingerprint(view);
    liveFingerprints.feed = feedFingerprint(view);
    liveFingerprints.quarter = quarterFingerprint(view);
    liveFingerprints.replay = replayFingerprint(view);
  }

  function schemaDriftFingerprint(report) {
    if (!report) return '';
    return [
      report.provider || 'provider',
      report.schema_version || 'schema',
      report.affected_sessions || 0,
      report.total_events || 0,
      report.recognized_events || 0,
      report.missing_event_type || 0,
      (report.unknown_event_types || []).map(function (row) {
        return (row.name || 'unknown') + ':' + (row.count || 0);
      }).join('|'),
    ].join('::');
  }

  function schemaDriftIssueBody(report) {
    var unknown = (report.unknown_event_types || []).slice(0, 10);
    var hints = report.hints || [];
    return [
      '## Schema drift report',
      '',
      'Copilot Mission Control detected local Copilot CLI events that do not match the current parser/schema assumptions.',
      '',
      'This report is structural only. It does not include prompts, tool arguments, command output, file paths, or diffs.',
      '',
      '### Summary',
      '',
      '- Provider: ' + (report.provider || 'copilot'),
      '- Schema version: ' + (report.schema_version || 'unknown'),
      '- Severity: ' + (report.severity || 'warning'),
      '- Checked sessions: ' + exactNumber(report.checked_sessions || 0),
      '- Affected sessions: ' + exactNumber(report.affected_sessions || 0),
      '- Total events sampled: ' + exactNumber(report.total_events || 0),
      '- Recognized events: ' + exactNumber(report.recognized_events || 0),
      '- Tool starts recognized: ' + exactNumber(report.tool_starts || 0),
      '- Tool completes recognized: ' + exactNumber(report.tool_completes || 0),
      '- Missing event type paths: ' + exactNumber(report.missing_event_type || 0),
      '',
      '### Unknown event types',
      '',
      unknown.length
        ? unknown.map(function (row) { return '- `' + (row.name || 'unknown') + '`: ' + exactNumber(row.count || 0); }).join('\n')
        : '- None reported',
      '',
      '### Parser hints',
      '',
      hints.length
        ? hints.map(function (hint) { return '- ' + hint; }).join('\n')
        : '- No specific hints reported',
    ].join('\n');
  }

  function schemaDriftIssueUrl(report) {
    var title = 'Schema drift detected: Copilot provider';
    var body = schemaDriftIssueBody(report);
    return 'https://github.com/DanWahlin/copilot-mission-control/issues/new?'
      + 'title=' + encodeURIComponent(title)
      + '&labels=' + encodeURIComponent('schema-drift,provider:copilot')
      + '&body=' + encodeURIComponent(body);
  }

  function openExternalUrl(url) {
    var tauriInvoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof tauriInvoke === 'function') {
      return tauriInvoke('open_external_url', { url: url });
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    return Promise.resolve();
  }

  function closeSchemaDriftDialog() {
    if (!schemaDriftOverlay) return;
    schemaDriftOverlay.classList.remove('visible');
    schemaDriftOverlay.setAttribute('aria-hidden', 'true');
  }

  function renderSchemaDriftDialog(report) {
    if (!schemaDriftOverlay || !schemaDriftSubtitle || !schemaDriftBody || !report) return;
    activeSchemaDriftReport = report;
    schemaDriftSubtitle.textContent = (report.summary || 'The Copilot provider saw unexpected event shapes.')
      + ' Review and report a privacy-safe issue if this looks wrong.';
    var unknown = (report.unknown_event_types || []).slice(0, 5).map(function (row) {
      return '<li><code>' + escapeHtml(row.name || 'unknown') + '</code>: ' + escapeHtml(exactNumber(row.count || 0)) + '</li>';
    }).join('');
    schemaDriftBody.innerHTML = '<p>The app can open a prefilled GitHub issue with structural parser details only.</p>'
      + '<dl class="inspector-stats">'
      + '<dt>Affected</dt><dd>' + escapeHtml(exactNumber(report.affected_sessions || 0)) + ' of ' + escapeHtml(exactNumber(report.checked_sessions || 0)) + ' sessions</dd>'
      + '<dt>Events</dt><dd>' + escapeHtml(exactNumber(report.recognized_events || 0)) + ' recognized / ' + escapeHtml(exactNumber(report.total_events || 0)) + ' sampled</dd>'
      + '<dt>Tools</dt><dd>' + escapeHtml(exactNumber(report.tool_starts || 0)) + ' starts / ' + escapeHtml(exactNumber(report.tool_completes || 0)) + ' completes</dd>'
      + '</dl>'
      + (unknown ? '<p>Unknown event types:</p><ul>' + unknown + '</ul>' : '<p>No unknown event type names were reported.</p>')
      + '<p class="cmc-muted">No prompts, tool arguments, command output, file paths, or diffs are included.</p>';
    schemaDriftOverlay.classList.add('visible');
    schemaDriftOverlay.setAttribute('aria-hidden', 'false');
    var dialog = $('schema-drift-dialog');
    if (dialog && dialog.focus) dialog.focus();
  }

  function maybeShowSchemaDrift(view) {
    var report = view && view.schemaDrift && view.schemaDrift[0];
    if (!report) return;
    var fingerprint = schemaDriftFingerprint(report);
    var dismissed = '';
    try {
      dismissed = window.localStorage && window.localStorage.getItem('cmc_schema_drift_dismissed');
    } catch (_err) {
      dismissed = '';
    }
    if (!fingerprint || fingerprint === lastSchemaDriftFingerprint || fingerprint === dismissed) return;
    lastSchemaDriftFingerprint = fingerprint;
    renderSchemaDriftDialog(report);
  }

  window.__cmcRenderDashboard = function (view) {
    lastDashboard = view;
    document.body.classList.add('dashboard-ready');
    requestDashboardSplashHide();
    var l = view.layout || {};
    var hideSides = !!view.panelsHidden;
    var columnGap = l.compact ? 10 : 12;
    var replayTop = Number.isFinite(l.replayY) && l.replayH > 0 ? l.replayY : l.bottomY;
    var columnBottom = Math.max(l.topY || 0, replayTop - columnGap);
    var columnH = Math.max(0, columnBottom - (l.topY || 0));
    var feedMinH = l.compact ? 130 : 160;
    var maxSessionH = Math.max(l.compact ? 160 : 180, columnH - feedMinH - columnGap);
    if (domSession) {
      domSession.classList.remove('hidden', 'constrained');
    }
    setPanelRect(domSession, { x: l.leftX, y: l.topY, w: l.panelW });
    renderSession(view);
    var naturalSessionH = domSession ? Math.ceil(domSession.getBoundingClientRect().height) : 0;
    var sessionMainH = Math.max(0, Math.min(naturalSessionH || maxSessionH, maxSessionH));
    var feedY = (l.topY || 0) + sessionMainH + columnGap;
    var feedH = Math.max(80, columnBottom - feedY);
    setPanelRect(domSession, { x: l.leftX, y: l.topY, w: l.panelW, h: sessionMainH });
    if (domSession) domSession.classList.toggle('constrained', naturalSessionH > sessionMainH + 1);
    setPanelRect(domFeed, { x: l.leftX, y: feedY, w: l.panelW, h: feedH });
    setPanelRect(domQuarter, { x: l.bottomX, y: l.bottomY, w: l.bottomW, h: l.bottomH });
    setPanelRect(domReplay, { x: l.replayX, y: l.replayY, w: l.replayW, h: l.replayH });
    [domSession, domFeed, domReplay].forEach(function (el) {
      if (el) el.classList.toggle('hidden', hideSides);
    });
    if (domQuarter) domQuarter.classList.toggle('hidden', false);
    renderFeed(view);
    renderQuarter(view);
    renderReplay(view);
    updateLiveFingerprints(view);
    maybeShowSchemaDrift(view);
  };

  window.__cmcRenderLiveDashboard = function (view) {
    lastDashboard = view;
    document.body.classList.add('dashboard-ready');
    requestDashboardSplashHide();
    var nextSession = sessionFingerprint(view);
    var nextFeed = feedFingerprint(view);
    var nextQuarter = quarterFingerprint(view);
    var nextReplay = replayFingerprint(view);
    if (nextSession !== liveFingerprints.session) {
      renderSession(view);
      liveFingerprints.session = nextSession;
    }
    if (nextFeed !== liveFingerprints.feed) {
      renderFeed(view);
      liveFingerprints.feed = nextFeed;
    }
    if (nextQuarter !== liveFingerprints.quarter) {
      renderQuarter(view);
      liveFingerprints.quarter = nextQuarter;
    }
    if (nextReplay !== liveFingerprints.replay) {
      renderReplay(view);
      liveFingerprints.replay = nextReplay;
    }
  };

  window.__cmcRenderQuarter = function (quarter) {
    if (lastDashboard) lastDashboard.quarter = quarter;
    renderQuarterData(quarter);
    liveFingerprints.quarter = quarterFingerprint({ quarter: quarter });
  };

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var menuTrigger = target.closest('[data-cmc-action="session-menu"]');
    if (menuTrigger) {
      toggleSessionMenu(menuTrigger);
      return;
    }
    var sessionBtn = target.closest('[data-session-id]');
    if (sessionBtn && typeof window.__cmcSelectSession === 'function') {
      closeSessionMenu();
      window.__cmcSelectSession(sessionBtn.getAttribute('data-session-id'));
      return;
    }
    if (!target.closest('.cmc-session-picker')) closeSessionMenu();
    var action = target.closest('[data-cmc-action]');
    if (!action) return;
    if (action.disabled || action.classList.contains('disabled')) return;
    var name = action.getAttribute('data-cmc-action');
    if (name === 'editor' && typeof window.__cmcOpenSelectedSessionInEditor === 'function') window.__cmcOpenSelectedSessionInEditor();
    if (name === 'inspector' && lastDashboard && lastDashboard.sessions && lastDashboard.sessions.selected) openInspector(lastDashboard.sessions.selected, action);
    if (name === 'quarter-details' && lastDashboard && lastDashboard.sessions && lastDashboard.sessions.selected) {
      openSectorInspector(lastDashboard.sessions.selected, {
        category: action.getAttribute('data-sector-category') || '',
        title: action.getAttribute('data-sector-title') || '',
        count: Number(action.getAttribute('data-sector-count') || 0),
        color: action.getAttribute('data-sector-color') || '',
      }, action);
    }
    if (name === 'replay-toggle' && typeof window.__cmcToggleReplayPause === 'function') window.__cmcToggleReplayPause();
    if (name === 'replay-live' && typeof window.__cmcJumpReplayToLive === 'function') window.__cmcJumpReplayToLive();
    if (name === 'replay-seek' && typeof window.__cmcSeekReplayRatio === 'function') {
      var rect = action.getBoundingClientRect();
      window.__cmcSeekReplayRatio((event.clientX - rect.left) / rect.width);
    }
  });

  [schemaDriftClose, schemaDriftDismiss].forEach(function (button) {
    if (!button) return;
    button.addEventListener('click', function () {
      if (activeSchemaDriftReport) {
        try {
          window.localStorage && window.localStorage.setItem('cmc_schema_drift_dismissed', schemaDriftFingerprint(activeSchemaDriftReport));
        } catch (_err) {
          // Ignore storage failures; the dialog can appear again on refresh.
        }
      }
      closeSchemaDriftDialog();
    });
  });

  if (schemaDriftReport) {
    schemaDriftReport.addEventListener('click', function () {
      if (!activeSchemaDriftReport) return;
      openExternalUrl(schemaDriftIssueUrl(activeSchemaDriftReport)).then(function () {
        closeSchemaDriftDialog();
      }).catch(function (err) {
        console.error('Unable to open schema drift issue URL', err);
      });
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      var openMenu = document.querySelector('.cmc-session-picker.open');
      if (openMenu) {
        event.preventDefault();
        closeSessionMenu();
        var trigger = openMenu.querySelector('[data-cmc-action="session-menu"]');
        if (trigger && typeof trigger.focus === 'function') trigger.focus();
        return;
      }
    }
    if (event.key === 'Escape' && schemaDriftOverlay && schemaDriftOverlay.classList.contains('visible')) {
      closeSchemaDriftDialog();
      return;
    }
    var target = event.target;
    if (!target || !target.matches || !target.matches('[data-cmc-action="replay-seek"]')) return;
    if (typeof window.__cmcSeekReplayRatio !== 'function') return;
    var max = Number(target.getAttribute('aria-valuemax') || 0);
    if (!max) return;
    var current = Number(target.getAttribute('aria-valuenow') || 0);
    var next = current;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - 1;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = max;
    else return;
    event.preventDefault();
    window.__cmcSeekReplayRatio(Math.max(0, Math.min(max, next)) / max);
  });

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.matches) return;
    if (target.matches('[data-cmc-action="session-select"]') && typeof window.__cmcSelectSession === 'function') {
      window.__cmcSelectSession(target.value);
    }
  });

  // -------------------------------------------------------------------
  // Panels toggle — hide/show the Selected Session + Activity Feed side
  // panels so the castle/buildings ring can expand to take up
  // the full width. The quarter inspector below the buildings + the
  // replay timeline stay visible so hover/click behavior + scrubber
  // controls keep working in focus mode.
  // -------------------------------------------------------------------

  var panelsBtn = $('panels-btn');
  var panelsHidden = safeGet('cmc_panels_hidden') === '1';

  // Two-state icon (state-based, like password-field toggles): icon
  // shows what's currently visible. Open eye when panels are shown,
  // eye-with-slash when panels are hidden. The tooltip describes the
  // click action so the meaning stays unambiguous either way.
  // Deep almond curve + filled pupil so the icon reads at the topbar size
  // without looking like a squashed slit.
  var ICON_EYE_OPEN = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M1.4 12 Q 12 2.3 22.6 12 Q 12 21.7 1.4 12 Z"/>'
    + '<circle class="pupil" cx="12" cy="12" r="4.1"/>'
    + '</svg>';
  var ICON_EYE_SLASH = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M1.4 12 Q 12 2.3 22.6 12 Q 12 21.7 1.4 12 Z"/>'
    + '<circle class="pupil" cx="12" cy="12" r="4.1"/>'
    + '<path d="M3.4 20.6 L 20.6 3.4"/>'
    + '</svg>';

  function applyPanelsState() {
    if (panelsBtn) {
      panelsBtn.innerHTML = panelsHidden ? ICON_EYE_SLASH : ICON_EYE_OPEN;
      panelsBtn.title = panelsHidden
        ? 'Show side panels'
        : 'Hide side panels for focus mode';
      panelsBtn.setAttribute('aria-label', panelsBtn.title);
      panelsBtn.setAttribute('aria-pressed', panelsHidden ? 'true' : 'false');
    }
    if (typeof window.__cmcSetPanelsHidden === 'function') {
      window.__cmcSetPanelsHidden(panelsHidden);
    }
  }

  function togglePanels() {
    panelsHidden = !panelsHidden;
    safeSet('cmc_panels_hidden', panelsHidden ? '1' : '0');
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
    if (typeof window.__cmcSetPanelsHidden === 'function' || panelsAttempts > 40) {
      clearInterval(panelsPoll);
      applyPanelsState();
    }
  }, 100);

  // -------------------------------------------------------------------
  // Update notification. Rust checks the signed Tauri updater manifest
  // once per app launch and calls this hook when a newer release exists.
  // -------------------------------------------------------------------

  window.__cmcUpdateAvailable = function (version) {
    var banner = $('update-banner');
    var versionEl = $('update-version');
    var dismissBtn = $('update-dismiss');
    var linkEl = banner ? banner.querySelector('.update-link') : null;
    var iconEl = banner ? banner.querySelector('.update-icon') : null;
    if (!banner || !versionEl) return;

    versionEl.textContent = 'v' + version;
    if (linkEl) linkEl.textContent = 'View Release';
    if (iconEl) iconEl.textContent = '🚀';
    var autoHideTimer = null;

    banner.onclick = function (event) {
      if (event.target === dismissBtn) return;
      openExternalUrl('https://github.com/DanWahlin/copilot-mission-control/releases/latest').catch(function (err) {
        console.error('Unable to open release URL', err);
      });
    };

    if (dismissBtn) {
      dismissBtn.onclick = function (event) {
        event.stopPropagation();
        banner.classList.remove('show');
        if (autoHideTimer) clearTimeout(autoHideTimer);
      };
    }

    setTimeout(function () { banner.classList.add('show'); }, 500);
    autoHideTimer = setTimeout(function () { banner.classList.remove('show'); }, 30000);
  };

  window.__cmcUpdateStatus = function (status) {
    var banner = $('update-banner');
    var linkEl = banner ? banner.querySelector('.update-link') : null;
    var iconEl = banner ? banner.querySelector('.update-icon') : null;
    if (status === 'downloading') {
      if (linkEl) linkEl.textContent = 'Downloading…';
      if (iconEl) iconEl.textContent = '📦';
    } else if (status === 'restarting') {
      if (linkEl) linkEl.textContent = 'Installing… Restarting';
      if (iconEl) iconEl.textContent = '✨';
    }
  };
})();
