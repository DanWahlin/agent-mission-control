// @ts-nocheck
// Agent Mission Control — slim DOM HUD.
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

  var settings = window.__cmcSettings;
  var STORAGE_KEYS = settings.keys;

  function safeGet(key) { return settings.get(key); }
  function safeSet(key, value) { settings.set(key, value); }
  function normalizeHistoryTab(tab) {
    return tab === 'flight-log' ? 'flight-log' : 'overview';
  }

  // -------------------------------------------------------------------
  // Theme toggle (light/dark).
  // -------------------------------------------------------------------

  var themeBtn = $('theme-btn');
  var currentTheme = safeGet(STORAGE_KEYS.theme) === 'light' ? 'light' : 'dark';
  var lastSceneTheme = null;

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
      if (lastSceneTheme === currentTheme) return;
      lastSceneTheme = currentTheme;
      window.__cmcSetTheme(currentTheme);
    }
  }

  function toggleTheme() {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    safeSet(STORAGE_KEYS.theme, currentTheme);
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
  var APP_THEME_KEY = STORAGE_KEYS.appTheme;
  var DEFAULT_APP_THEME = 'space';
  var APP_THEMES = ['space', 'medieval'];
  var lastSceneAppTheme = null;

  function normalizeAppTheme(value) {
    return APP_THEMES.indexOf(value) >= 0 ? value : DEFAULT_APP_THEME;
  }

  function applyAppTheme(value) {
    var nextTheme = normalizeAppTheme(value);
    document.body.dataset.appTheme = nextTheme;
    if (appThemeSelect && appThemeSelect.value !== nextTheme) appThemeSelect.value = nextTheme;
    safeSet(APP_THEME_KEY, nextTheme);
    if (typeof window.__cmcSetAppTheme === 'function') {
      if (lastSceneAppTheme === nextTheme) return;
      lastSceneAppTheme = nextTheme;
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

  var resetBtn = $('reset-btn');
  var lastModel = '';

  function updateModelChipElement(model, force) {
    var modelEl = $('model-chip');
    var labelEl = $('model-label');
    var next = (model == null ? '' : String(model)).trim();
    if (!force && next === lastModel) return;
    lastModel = next;
    var label = modelLabelText(next);
    if (labelEl) labelEl.textContent = label + ':';
    if (!modelEl) return;
    if (next === '') {
      modelEl.classList.add('empty');
      modelEl.textContent = '';
      modelEl.title = 'Active model for the selected session';
    } else {
      modelEl.classList.remove('empty');
      modelEl.textContent = next;
      modelEl.title = 'Active model: ' + next;
    }
  }

  window.__cmcUpdateModel = function (model) {
    updateModelChipElement(model, false);
  };

  function modelLabelText(model) {
    var models = String(model || '').split(',').map(function (part) { return part.trim(); }).filter(Boolean);
    return models.length > 1 ? 'Models' : 'Model';
  }

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
  var expandedAggregateSessionGroups = new Set();

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

  function formatHistoryAxisTime(ms) {
    var date = new Date(ms);
    if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: 'numeric' });
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
    if (n >= 1000000) return Math.round(n / 1000000) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
  }

  function toolKey(call) {
    if (!call) return '';
    var source = call.source_session_id ? call.source_session_id + '|' : '';
    return source + (call.event_ref || call.call_id || [call.timestamp, call.tool, call.category].join('|'));
  }

  function callKindLabel(call) {
    var category = call && call.category;
    if (category === 'mcp') return 'MCP tool';
    if (category === 'skills') return 'Skill';
    if (category === 'delegates') return 'Sub-agent';
    if (category === 'terminal') return 'Command';
    if (category === 'signal') return 'Web/docs';
    if (category === 'hooks') return 'Hook';
    if (category === 'edits') return 'Edit';
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
      var sectorCalls = calls.filter(function (call) { return call.category === sectorInspectorContext.category; });
      if (inspectorSession && inspectorSession.is_all_sessions) {
        return sectorCalls.sort(function (a, b) {
          var group = String(a.source_session_label || '').localeCompare(String(b.source_session_label || ''));
          if (group !== 0) return group;
          return String(b.timestamp || '').localeCompare(String(a.timestamp || ''));
        });
      }
      return sectorCalls;
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

  function aggregateGroupKey(call) {
    if (!call) return 'unknown';
    return call.source_session_id || call.source_session_label || 'unknown';
  }

  function aggregateGroupLabel(call) {
    return (call && call.source_session_label) || 'Unknown session';
  }

  function aggregateGroupIsExpanded(key) {
    return expandedAggregateSessionGroups.has(key);
  }

  function visibleAggregateCalls(calls) {
    if (!(inspectorScope === 'sector' && inspectorSession && inspectorSession.is_all_sessions)) return calls;
    return calls.filter(function (call) { return aggregateGroupIsExpanded(aggregateGroupKey(call)); });
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
    if (!state.details || !state.details.raw_args) return 'not available in the retained event';
    return state.details.raw_args + (state.details.raw_args_truncated ? '\n\n[truncated]' : '');
  }

  function revealOutputText(state) {
    if (!state || state.status !== 'ready') return 'hidden by privacy boundary';
    if (!state.details) return 'not retained by provider schema';
    if (state.details.raw_output) {
      return state.details.raw_output + (state.details.raw_output_truncated ? '\n\n[truncated]' : '');
    }
    return state.details.raw_output_scan_limited
      ? 'not found within the retained scan window'
      : 'not retained by provider schema';
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
        var signalScope = inspectorSession && inspectorSession.is_all_sessions ? 'signals' : 'selected-session signals';
        var message = total > 0
          ? 'This sector recorded ' + exactNumber(total) + ' ' + signalScope + ', but no detailed rows are in the retained call window.'
          : 'No retained rows for the selected ' + sector + ' sector.';
        inspectorList.innerHTML = '<div class="inspector-empty">' + escapeHtml(message) + '</div>';
        return;
      }
      inspectorList.innerHTML = '<div class="inspector-empty">No ' + escapeHtml(inspectorTab) + ' calls retained for this session.</div>';
      return;
    }
    var grouped = inspectorScope === 'sector' && inspectorSession && inspectorSession.is_all_sessions;
    var currentGroup = '';
    var currentGroupTotal = 0;
    if (grouped) {
      var groupCounts = new Map();
      calls.forEach(function (call) {
        var key = aggregateGroupKey(call);
        groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
      });
    }
    inspectorList.innerHTML = calls.map(function (call) {
      var key = toolKey(call);
      var active = selected && toolKey(selected) === key;
      var duration = typeof call.duration_ms === 'number' ? formatDuration(call.duration_ms) : 'in flight';
      var fullName = toolDisplayName(call);
      var sessionLabel = aggregateGroupLabel(call);
      var groupKey = aggregateGroupKey(call);
      var expanded = aggregateGroupIsExpanded(groupKey);
      var groupHtml = '';
      if (grouped && groupKey !== currentGroup) {
        currentGroup = groupKey;
        currentGroupTotal = groupCounts.get(groupKey) || 0;
        groupHtml = '<button class="inspector-group-heading ' + (expanded ? 'expanded' : 'collapsed') + '" type="button"'
          + ' data-inspector-group-key="' + escapeHtml(groupKey) + '"'
          + ' aria-expanded="' + (expanded ? 'true' : 'false') + '">'
          + '<span class="inspector-group-main">'
          + '<span class="inspector-group-caret" aria-hidden="true">' + (expanded ? '-' : '+') + '</span>'
          + '<span class="inspector-group-title">' + escapeHtml(sessionLabel) + '</span>'
          + '</span>'
          + '<span class="inspector-group-count">' + currentGroupTotal + ' item' + (currentGroupTotal === 1 ? '' : 's') + '</span>'
          + '</button>';
      }
      if (grouped && !expanded) {
        return groupHtml;
      }
      return groupHtml + '<button class="inspector-row ' + (active ? 'active ' : '') + (!call.success ? 'failed' : '') + '" type="button" data-tool-key="' + escapeHtml(key) + '">'
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
        var retainedRows = filteredCalls().length;
        var emptyMessage = inspectorSession && inspectorSession.is_all_sessions
          ? 'Expand a session group, then select a retained row to inspect.'
          : 'Select a retained row when one is available.';
        inspectorDetail.innerHTML = '<h3>Sector details</h3>' + kvRows([
          ['Sector', sectorInspectorContext.title || categoryLabel(sectorInspectorContext.category)],
          ['Signals', exactNumber(total)],
          ['Retained rows', String(retainedRows)],
        ]) + '<div class="inspector-empty">' + escapeHtml(emptyMessage) + '</div>';
        return;
      }
      inspectorDetail.innerHTML = '<h3>Details</h3><div class="inspector-empty">Select a tool call to inspect.</div>';
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
    if (call.source_session_label) rows.unshift(['Session', call.source_session_label]);
    if (turn) rows.push(['Turn status', turn.status + (turn.partial ? ' · partial tail window' : '')]);
    (call.details || []).forEach(function (detail) { rows.push([detail.label, detail.value]); });
    var revealState = activeRevealState(call);
    rows.push(['Raw args', revealArgsText(revealState)]);
    rows.push(['Output', revealOutputText(revealState)]);
    inspectorDetail.innerHTML = '<h3>Details</h3>' + kvRows(rows) + renderRevealPanel(call, revealState);
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
    var heading = selectedSessionHeading(inspectorSession);
    var scope = heading.subtitle || heading.title;
    var sectorCalls = inspectorScope === 'sector' ? filteredCalls() : null;
    if (inspectorToolbar) inspectorToolbar.hidden = inspectorScope === 'sector';
    if (inspectorScope === 'sector' && sectorInspectorContext) {
      if (inspectorTitle) {
        inspectorTitle.innerHTML = '<span class="inspector-title-swatch" style="--swatch:' + escapeHtml(sectorInspectorContext.color || CATEGORY_COLORS[sectorInspectorContext.category] || '#ffd54a') + '"></span>'
          + escapeHtml((sectorInspectorContext.title || categoryLabel(sectorInspectorContext.category)) + ' details · ' + heading.title);
      }
      if (inspectorSubtitle) {
        var retained = sectorCalls ? sectorCalls.length : 0;
        var total = Number(sectorInspectorContext.count || 0);
        var signalScope = inspectorSession && inspectorSession.is_all_sessions ? 'signals' : 'selected-session signals';
        inspectorSubtitle.textContent = scope
          + ' · ' + retained + ' retained rows · ' + exactNumber(total) + ' ' + signalScope;
      }
    } else {
      if (inspectorTitle) inspectorTitle.textContent = 'Inspector · ' + heading.title;
      if (inspectorSubtitle) {
        var calls = (inspectorSession.recent_tool_calls || []).length;
        var turns = (inspectorSession.recent_turns || []).length;
        inspectorSubtitle.textContent = scope + ' · ' + calls + ' calls · ' + turns + ' turns';
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
      if (inspectorSession && inspectorSession.is_all_sessions) {
        sectorCall = selectedCall(visibleAggregateCalls(sectorCalls || []));
      }
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
    if (session.is_all_sessions) return false;
    inspectorReturnFocus = trigger || document.activeElement;
    inspectorSession = session;
    inspectorScope = 'session';
    sectorInspectorContext = null;
    inspectorMode = 'tools';
    inspectorTab = 'all';
    selectedToolKey = '';
    selectedTurnId = '';
    rawRevealState = null;
    expandedAggregateSessionGroups = new Set();
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
    expandedAggregateSessionGroups = new Set();
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
    expandedAggregateSessionGroups = new Set();
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
    if (inspectorSession.is_all_sessions && !call.source_session_id) {
      rawRevealState = { key: key, status: 'error', error: 'Cannot reveal raw details because the source session is missing.' };
      renderToolDetail(call);
      return;
    }
    if (!invoke) {
      rawRevealState = { key: key, status: 'error', error: 'Raw local details require the Tauri app.' };
      renderToolDetail(call);
      return;
    }
    rawRevealState = { key: key, status: 'loading' };
    renderToolDetail(call);
    invoke('get_raw_tool_call_details', {
      provider: call.source_session_provider || inspectorSession.provider || 'copilot',
      sessionId: call.source_session_id || inspectorSession.id,
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
    var groupBtn = target.closest('[data-inspector-group-key]');
    if (groupBtn) {
      var groupKey = groupBtn.getAttribute('data-inspector-group-key') || '';
      if (expandedAggregateSessionGroups.has(groupKey)) {
        expandedAggregateSessionGroups.delete(groupKey);
      } else {
        expandedAggregateSessionGroups.add(groupKey);
      }
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
  var gameRoot = $('game');
  var dashboardOverlay = $('dashboard-overlay');
  var historyScreen = $('history-screen');
  var analyticsChatScreen = $('analytics-chat-screen');
  var analyticsChatStatus = $('analytics-chat-status');
  var analyticsChatSuggestions = $('analytics-chat-suggestions');
  var analyticsChatTranscript = $('analytics-chat-transcript');
  var analyticsChatForm = $('analytics-chat-form');
  var analyticsChatInput = $('analytics-chat-input');
  var analyticsChatNew = $('analytics-chat-new');
  var analyticsTokenNotice = $('analytics-token-notice');
  var analyticsTokenDialog = analyticsTokenNotice && analyticsTokenNotice.querySelector('.analytics-token-dialog');
  var analyticsTokenAck = $('analytics-token-ack');
  var analyticsTokenHelp = $('analytics-token-help');
  var analyticsPromptPanelHidden = settings.getBool(STORAGE_KEYS.analyticsPromptPanelCollapsed);
  var analyticsTokenNoticeSeen = settings.getBool(STORAGE_KEYS.analyticsTokenNoticeSeen);
  var analyticsTokenReturnFocus = null;
  var historyContent = $('history-content');
  var historyOverviewPanel = $('history-overview-panel');
  var historyFlightLogPanel = $('history-flight-log-panel');
  var historyFlightLogContent = $('history-flight-log-content');
  var historyOverviewTab = $('history-overview-tab');
  var historyFlightLogTab = $('history-flight-log-tab');
  var historyKpiSummary = $('history-kpi-summary');
  var historySubtitle = $('history-subtitle');
  var historyLiveStamp = $('history-live-stamp');
  var historySessionFilterSelect = $('history-session-filter');
  var missionRouteBtn = $('mission-route-btn');
  var historyRouteBtn = $('history-route-btn');
  var analyticsRouteBtn = $('analytics-route-btn');
  var domLoadingImage = domLoading ? domLoading.querySelector('img') : null;
  var attentionOverlay = $('attention-overlay');
  var attentionDialog = $('attention-dialog');
  var attentionSubtitle = $('attention-subtitle');
  var attentionBody = $('attention-body');
  var attentionClose = $('attention-close');
  var schemaDriftOverlay = $('schema-drift-overlay');
  var schemaDriftSubtitle = $('schema-drift-subtitle');
  var schemaDriftBody = $('schema-drift-body');
  var schemaDriftClose = $('schema-drift-close');
  var schemaDriftDismiss = $('schema-drift-dismiss');
  var schemaDriftReport = $('schema-drift-report');
  var lastDashboard = null;
  var attentionReturnFocus = null;
  var activeSchemaDriftReport = null;
  var lastSchemaDriftFingerprint = '';
  var historySessionFilter = 'all';
  var historyTab = normalizeHistoryTab(safeGet(STORAGE_KEYS.historyTab));
  var DASHBOARD_SPLASH_MIN_MS = Number.isFinite(Number(window.__cmcSplashMinMs))
    ? Math.max(0, Number(window.__cmcSplashMinMs))
    : 2000;
  var dashboardSplashVisibleAt = nowMs();
  var dashboardSplashImageSettled = !domLoadingImage || domLoadingImage.complete;
  var dashboardSplashHideRequested = false;
  var dashboardSplashTimer = 0;
  var liveFingerprints = {
    session: '',
    attention: '',
    feed: '',
    quarter: '',
    replay: '',
    history: '',
  };
  var RECENT_ACTIVITY_VISIBLE_ROWS = 5;
  var appRoute = routeFromHash();
  var historyFetchFrame = 0;
  var historyFetchTimer = 0;
  var historyBarRefreshFrame = 0;
  var cachedHistoryDashboard = null;
  var cachedHistoryAtMs = 0;
  var HISTORY_ROUTE_CACHE_MS = 60 * 1000;
  var HISTORY_ANALYTICS_RANGE_DAYS = 7;
  var historyAnalyticsSummary = null;
  var historyAnalyticsLoadedAtMs = 0;
  var historyAnalyticsLoading = false;
  var historyAnalyticsError = '';
  var flightLogDigest = null;
  var flightLogLoading = false;
  var flightLogError = '';
  var flightLogSelectedDay = localDayString(new Date());
  var flightLogMonth = flightLogSelectedDay.slice(0, 7);
  var flightLogCopyStatus = '';
  var flightLogExpandedExports = {};
  var flightLogRequestSeq = 0;
  var analyticsChatMessages = [];
  var analyticsChatLoading = false;
  var analyticsChatRequestSeq = 0;
  var analyticsStatusCache = null;
  var ANALYTICS_PROMPTS = [
    'What changed in my Copilot CLI usage this week?',
    'Where are my token hotspots?',
    'Which tools failed the most?',
    'Compare my recent model mix.',
    'What\'s my MCP server usage?',
    'How can I improve my prompts?',
    'Review my Copilot skills.',
    'Review my Copilot agents.',
    'What skill or agent gaps do I have?',
  ];

  function nowMs() {
    return window.performance && typeof window.performance.now === 'function'
      ? window.performance.now()
      : Date.now();
  }

  function localDayString(date) {
    var d = date instanceof Date ? date : new Date(date || Date.now());
    if (Number.isNaN(d.getTime())) d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function localMonthLabel(month) {
    var date = new Date(String(month || '').slice(0, 7) + '-01T12:00:00');
    if (Number.isNaN(date.getTime())) date = new Date();
    return date.toLocaleDateString([], { month: 'long', year: 'numeric' });
  }

  function localDateLabel(day) {
    var date = new Date(String(day || '') + 'T12:00:00');
    if (Number.isNaN(date.getTime())) return String(day || 'selected day');
    return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function shiftMonth(month, delta) {
    var date = new Date(String(month || flightLogMonth).slice(0, 7) + '-01T12:00:00');
    if (Number.isNaN(date.getTime())) date = new Date();
    date.setMonth(date.getMonth() + delta);
    return localDayString(date).slice(0, 7);
  }

  function lastSelectableDayForMonth(month) {
    var normalized = String(month || flightLogMonth).slice(0, 7);
    var today = localDayString(new Date());
    if (normalized >= today.slice(0, 7)) return today;
    var first = new Date(normalized + '-01T12:00:00');
    if (Number.isNaN(first.getTime())) return today;
    first.setMonth(first.getMonth() + 1);
    first.setDate(0);
    return localDayString(first);
  }

  function clampSelectableMonth(month) {
    var normalized = String(month || flightLogMonth).slice(0, 7);
    var todayMonth = localDayString(new Date()).slice(0, 7);
    return normalized > todayMonth ? todayMonth : normalized;
  }

  function routeFromHash() {
    var hash = String(window.location.hash || '').toLowerCase();
    if (hash === '#history') return 'history';
    if (hash === '#analytics' || hash === '#analytics-chat') return 'analytics';
    return 'mission';
  }

  function syncRouteHash(route) {
    var target = route === 'history' ? '#history' : (route === 'analytics' ? '#analytics-chat' : '#mission');
    if (window.location.hash === target) return;
    if (window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', target);
    } else {
      window.location.hash = target;
    }
  }

  function setRouteButtonState(button, active) {
    if (!button) return;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  function dashboardHasLoadedHistory(view) {
    return !!(view && view.history && Number(view.history.generated_at_ms || 0) > 0);
  }

  function cachedHistoryIsFresh() {
    return dashboardHasLoadedHistory(cachedHistoryDashboard)
      && Date.now() - cachedHistoryAtMs < HISTORY_ROUTE_CACHE_MS;
  }

  function rememberHistoryDashboard(view) {
    if (!dashboardHasLoadedHistory(view)) return;
    cachedHistoryDashboard = view;
    cachedHistoryAtMs = Date.now();
  }

  function historyDashboardForRoute(view) {
    if (dashboardHasLoadedHistory(view)) return view;
    return cachedHistoryIsFresh() ? cachedHistoryDashboard : null;
  }

  function cancelScheduledHistoryFetch() {
    if (historyFetchFrame) {
      window.cancelAnimationFrame(historyFetchFrame);
      historyFetchFrame = 0;
    }
    if (historyFetchTimer) {
      window.clearTimeout(historyFetchTimer);
      historyFetchTimer = 0;
    }
  }

  function scheduleHistoryFetch() {
    if (historyFetchFrame || historyFetchTimer) return;
    if (cachedHistoryIsFresh()) return;
    historyFetchFrame = window.requestAnimationFrame(function () {
      historyFetchFrame = 0;
      historyFetchTimer = window.setTimeout(function () {
        historyFetchTimer = 0;
        if (appRoute !== 'history') return;
        if (cachedHistoryIsFresh()) return;
        if (typeof window.__cmcFetchHistory === 'function') window.__cmcFetchHistory();
      }, 0);
    });
  }

  function unloadHistoryRoute() {
    cancelScheduledHistoryFetch();
    if (historyBarRefreshFrame) {
      window.cancelAnimationFrame(historyBarRefreshFrame);
      historyBarRefreshFrame = 0;
    }
    liveFingerprints.history = '';
  }

  function analyticsFixture() {
    return window.__analyticsChatFixture || window.__analyticsFixture || null;
  }

  function callAnalyticsCommand(command, payload) {
    var fixture = analyticsFixture();
    if (fixture) {
      if (command === 'get_analytics_status') return Promise.resolve(fixture.status || defaultAnalyticsStatus());
      if (command === 'ask_analytics_chat') return Promise.resolve(fixture.chat || defaultAnalyticsChat(payload && payload.request && payload.request.prompt));
      if (command === 'get_analytics_usage_summary') return Promise.resolve(fixture.summary || defaultAnalyticsUsageSummary());
      if (command === 'get_engineering_digest') {
        var digest = typeof fixture.digest === 'function' ? fixture.digest(payload && payload.request) : fixture.digest;
        return Promise.resolve(digest || defaultEngineeringDigest(payload && payload.request));
      }
    }
    var invoke = tauriInvoke();
    if (!invoke) {
      if (command === 'get_analytics_status') return Promise.resolve(defaultAnalyticsStatus());
      if (command === 'ask_analytics_chat') return Promise.resolve(defaultAnalyticsChat(payload && payload.request && payload.request.prompt));
      if (command === 'get_analytics_usage_summary') return Promise.resolve(defaultAnalyticsUsageSummary());
      if (command === 'get_engineering_digest') return Promise.resolve(defaultEngineeringDigest(payload && payload.request));
    }
    return invoke(command, payload || {});
  }

  function defaultAnalyticsStatus() {
    return {
      available: false,
      ingestion_running: false,
      session_count: 0,
      event_count: 0,
      db_size_bytes: 0,
      snapshot_limited: true,
      privacy_summary: 'Analytics chat uses indexed local Copilot CLI history and derived metrics.',
      warnings: ['Open the Tauri app to index local analytics data.'],
    };
  }

  function defaultAnalyticsChat(prompt) {
    return {
      prompt: prompt || ANALYTICS_PROMPTS[0],
      answer: 'Analytics chat is ready, but local Tauri analytics are not available in this browser preview.',
      artifacts: [
        {
          kind: 'cards',
          title: 'Preview recommendations',
          cards: [
            {
              title: 'Run in the desktop app',
              body: 'The packaged Tauri app can scan local Copilot CLI summaries and return grounded artifacts.',
              severity: 'info',
              metric: 'preview',
            },
          ],
        },
      ],
      caveats: ['Browser preview uses fixture data unless window.__analyticsChatFixture is provided.'],
    };
  }

  function defaultAnalyticsUsageSummary() {
    return {
      generated_at_ms: 0,
      range_days: HISTORY_ANALYTICS_RANGE_DAYS,
      metrics: [],
      daily: [],
      model_mix: [],
      token_hotspots: [],
      tool_failures: [],
      recommendations: [],
      caveats: ['Open the Tauri app to index local analytics data.'],
    };
  }

  function defaultEngineeringDigest(request) {
    var selectedDay = request && request.selected_day || flightLogSelectedDay || localDayString(new Date());
    var month = request && request.month || selectedDay.slice(0, 7);
    var date = new Date(month + '-01T12:00:00');
    if (Number.isNaN(date.getTime())) date = new Date();
    var selected = new Date(selectedDay + 'T12:00:00');
    if (Number.isNaN(selected.getTime())) selected = new Date();
    var first = new Date(selected);
    first.setDate(selected.getDate() - selected.getDay() - 28);
    var calendarDays = [];
    var totalDays = Math.max(1, Math.round((selected.getTime() - first.getTime()) / 86400000) + 1);
    for (var i = 0; i < totalDays; i++) {
      var dayDate = new Date(first);
      dayDate.setDate(first.getDate() + i);
      var localDay = localDayString(dayDate);
      calendarDays.push({
        local_day: localDay,
        day_number: dayDate.getDate(),
        in_month: localDay.slice(0, 7) === month,
        enabled: false,
        is_today: localDay === localDayString(new Date()),
        intensity: 0,
        sessions: 0,
        events: 0,
        turns: 0,
        tool_calls: 0,
        failures: 0,
        input_tokens: 0,
        output_tokens: 0,
        estimated_active_ms: 0,
        partial: false,
        badges: [],
      });
    }
    return {
      generated_at_ms: 0,
      selected_day: selectedDay,
      month: month,
      available_years: [Number(selectedDay.slice(0, 4)) || new Date().getFullYear()],
      calendar_days: calendarDays,
      day: {
        local_day: selectedDay,
        totals: [],
        activity_rate: [],
        repos: [],
        models: [],
        tools: [],
        failures: [],
        token_hotspots: [],
        useful_sessions: [],
        narrative: 'No indexed Copilot CLI activity is available for ' + selectedDay + '.',
        exports: [],
      },
      caveats: ['Open the Tauri app to build the Daily Log from local analytics.'],
    };
  }

  function renderAnalyticsSuggestions() {
    if (!analyticsChatSuggestions) return;
    var toggleIcon = analyticsPromptPanelHidden
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    analyticsChatSuggestions.hidden = false;
    analyticsChatSuggestions.setAttribute('aria-hidden', 'false');
    analyticsChatSuggestions.classList.toggle('collapsed', analyticsPromptPanelHidden);
    analyticsChatSuggestions.innerHTML = '<button class="analytics-chat-prompt-close" type="button" data-analytics-prompt-toggle aria-expanded="' + (analyticsPromptPanelHidden ? 'false' : 'true') + '" aria-label="' + (analyticsPromptPanelHidden ? 'Show suggested prompts' : 'Hide suggested prompts') + '">' + toggleIcon + '</button>'
      + '<p class="analytics-chat-prompt-copy">Ask a question and I\'ll answer from local derived metrics and include charts, tables, or recommendations when available.</p>'
      + '<div class="analytics-chat-prompt-list"' + (analyticsPromptPanelHidden ? ' hidden' : '') + '>' + renderAnalyticsPromptChips() + '</div>';
  }

  function renderAnalyticsPromptChips() {
    return ANALYTICS_PROMPTS.map(function (prompt) {
      return '<button class="analytics-chip" type="button" data-analytics-prompt="' + escapeHtml(prompt) + '">' + escapeHtml(prompt) + '</button>';
    }).join('');
  }

  function maybeShowAnalyticsTokenNotice(returnFocus) {
    if (!analyticsTokenNotice || analyticsTokenNoticeSeen) return;
    analyticsTokenReturnFocus = returnFocus || document.activeElement;
    analyticsTokenNotice.classList.add('visible');
    analyticsTokenNotice.setAttribute('aria-hidden', 'false');
    if (analyticsTokenDialog && analyticsTokenDialog.focus) analyticsTokenDialog.focus();
  }

  function showAnalyticsTokenNotice(returnFocus) {
    if (!analyticsTokenNotice) return;
    analyticsTokenReturnFocus = returnFocus || document.activeElement;
    analyticsTokenNotice.classList.add('visible');
    analyticsTokenNotice.setAttribute('aria-hidden', 'false');
    if (analyticsTokenDialog && analyticsTokenDialog.focus) analyticsTokenDialog.focus();
  }

  function closeAnalyticsTokenNotice() {
    if (!analyticsTokenNotice) return;
    analyticsTokenNoticeSeen = true;
    settings.setBool(STORAGE_KEYS.analyticsTokenNoticeSeen, true);
    analyticsTokenNotice.classList.remove('visible');
    analyticsTokenNotice.setAttribute('aria-hidden', 'true');
    if (analyticsTokenReturnFocus && analyticsTokenReturnFocus.focus) {
      analyticsTokenReturnFocus.focus({ preventScroll: true });
    }
    analyticsTokenReturnFocus = null;
  }

  function renderAnalyticsStatus(status) {
    analyticsStatusCache = status || analyticsStatusCache || defaultAnalyticsStatus();
    if (analyticsChatStatus) {
      var statusText = analyticsStatusCache.ingestion_running
        ? 'Analyzing Copilot history…'
        : analyticsStatusCache.available
        ? 'Ready · ' + exactNumber(analyticsStatusCache.session_count || 0) + ' sessions · ' + exactNumber(analyticsStatusCache.event_count || 0) + ' recent facts'
        : 'Waiting for analytics ingestion';
      analyticsChatStatus.textContent = statusText;
    }
  }

  function renderAnalyticsChat() {
    if (!analyticsChatTranscript) return;
    if (!analyticsChatMessages.length) {
      analyticsChatTranscript.innerHTML = '';
      analyticsChatTranscript.scrollTop = 0;
      return;
    }
    analyticsChatTranscript.innerHTML = analyticsChatMessages.map(renderAnalyticsMessage).join('');
    analyticsChatMessages.forEach(function (message) {
      if (message) message.entering = false;
    });
    scrollAnalyticsTranscriptToLatest();
  }

  function scrollAnalyticsTranscriptToLatest() {
    if (!analyticsChatTranscript) return;
    window.requestAnimationFrame(function () {
      var messages = analyticsChatTranscript.querySelectorAll('.analytics-message');
      var latest = messages[messages.length - 1];
      if (!latest) {
        analyticsChatTranscript.scrollTop = 0;
        return;
      }
      analyticsChatTranscript.scrollTop = analyticsChatTranscript.scrollHeight;
    });
  }

  function renderAnalyticsMessage(message) {
    var isAssistant = message.role !== 'user';
    var label = message.role === 'user' ? 'You' : 'Assistant';
    if (isAssistant && message.loading) {
      label += '<span class="analytics-label-spinner" aria-label="Assistant is thinking"></span>';
    }
    var classes = ['analytics-message', message.role || 'assistant'];
    if (message.entering) classes.push('entering');
    var html = '<div class="' + classes.map(escapeHtml).join(' ') + '">'
      + '<div class="analytics-message-label">' + label + '</div>'
      + '<div class="analytics-message-body">' + renderLightMarkdown(message.text || '') + '</div>';
    if (message.toolCalls && message.toolCalls.length) {
      html += '<div class="analytics-tool-calls">' + message.toolCalls.map(function (toolName) {
        return '<div>Calling MCP tool ' + escapeHtml(toolName) + '</div>';
      }).join('') + '</div>';
    }

    function renderLightMarkdown(text) {
      var lines = String(text || '').split(/\r?\n/);
      var html = '';
      var paragraph = [];
      var list = [];
      function renderInlineMarkdown(value) {
        return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      }
      function flushParagraph() {
        if (!paragraph.length) return;
        html += '<p>' + renderInlineMarkdown(paragraph.join(' ')) + '</p>';
        paragraph = [];
      }
      function flushList() {
        if (!list.length) return;
        html += '<ul>' + list.map(function (item) {
          return '<li>' + renderInlineMarkdown(item) + '</li>';
        }).join('') + '</ul>';
        list = [];
      }
      lines.forEach(function (line) {
        var trimmed = line.trim();
        if (!trimmed) {
          flushParagraph();
          flushList();
          return;
        }
        var bullet = /^[-*]\s+(.+)$/.exec(trimmed);
        if (bullet) {
          flushParagraph();
          list.push(bullet[1]);
          return;
        }
        flushList();
        paragraph.push(trimmed);
      });
      flushParagraph();
      flushList();
      return html || '<p></p>';
    }
    if (message.artifacts && message.artifacts.length) {
      html += '<div class="analytics-artifacts">' + orderedAnalyticsArtifacts(message.artifacts).map(renderAnalyticsArtifact).join('') + '</div>';
    }
    if (message.caveats && message.caveats.length) {
      html += '<div class="analytics-caveats">' + message.caveats.map(function (caveat) {
        return '<div>• ' + escapeHtml(caveat) + '</div>';
      }).join('') + '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderAnalyticsArtifact(artifact) {
    var kind = artifact && artifact.kind;
    var body = '';
    if (kind === 'table' || kind === 'wide_table') body = renderAnalyticsTable(artifact);
    else if (kind === 'mcp_server_usage') body = renderAnalyticsMcpUsage(artifact);
    else if (kind === 'definition_inventory') body = renderAnalyticsDefinitionInventory(artifact);
    else if (kind === 'chart') body = renderAnalyticsBars(artifact.points || []);
    else if (kind === 'bars') body = renderAnalyticsValueBars(artifact);
    else if (kind === 'cards') body = renderAnalyticsCards(artifact.cards || []);
    else body = '<div class="analytics-caveats">No structured data for this artifact.</div>';
    var className = kind === 'cards' ? 'analytics-artifact analytics-artifact-cards'
      : kind === 'wide_table' || kind === 'definition_inventory' || kind === 'mcp_server_usage' ? 'analytics-artifact analytics-artifact-wide'
      : 'analytics-artifact';
    var description = artifact && artifact.description
      ? '<p class="analytics-artifact-copy">' + escapeHtml(artifact.description) + '</p>'
      : '';
    return '<section class="' + className + '"><h3>' + escapeHtml((artifact && artifact.title) || 'Artifact') + '</h3>' + description + body + '</section>';
  }

  function orderedAnalyticsArtifacts(artifacts) {
    return (artifacts || [])
      .map(function (artifact, index) {
        return { artifact: artifact, index: index, failure: isFailureArtifact(artifact) };
      })
      .sort(function (left, right) {
        if (left.failure !== right.failure) return left.failure ? 1 : -1;
        return left.index - right.index;
      })
      .map(function (entry) { return entry.artifact; });
  }

  function isFailureArtifact(artifact) {
    var title = String((artifact && artifact.title) || '').toLowerCase();
    return title.indexOf('failure') >= 0 || title.indexOf('failures') >= 0;
  }

  function renderAnalyticsTable(artifact) {
    var columns = artifact.columns || [];
    var rows = artifact.rows || [];
    if (!rows.length) return '<div class="analytics-caveats">No rows for this range.</div>';
    var title = String((artifact && artifact.title) || '').toLowerCase();
    var tableClass = 'analytics-table';
    var scrollClass = 'analytics-table-scroll';
    if (title.indexOf('overlap candidates') >= 0) tableClass += ' analytics-table-overlap';
    if (title.indexOf('model shifts') >= 0 || title.indexOf('tool and failure changes') >= 0) tableClass += ' analytics-table-comparison';
    if (title === 'model mix') tableClass += ' analytics-table-model-mix';
    if (title === 'model shifts') tableClass += ' analytics-table-model-shifts';
    if (title === 'tool failures') tableClass += ' analytics-table-tool-failures';
    if (title === 'session token hotspots') tableClass += ' analytics-table-token-hotspots';
    var isReadinessTable = title.indexOf('completeness gaps') >= 0 || title.indexOf('readiness checks') >= 0;
    if (isReadinessTable) {
      tableClass += ' analytics-table-completeness';
      scrollClass += ' analytics-table-scroll-compact';
    }

    return '<div class="' + scrollClass + '"><table class="' + tableClass + '"><thead><tr>' + columns.map(function (col) {
      return '<th>' + renderAnalyticsColumnHeading(col, title) + '</th>';
    }).join('') + '</tr></thead><tbody>' + rows.map(function (row) {
      return '<tr>' + (row || []).map(function (cell, index) {
        if (isReadinessTable && (columns[index] === 'Details' || columns[index] === 'Open')) {
          var details = parseDefinitionDetails(cell);
          var encoded = encodeURIComponent(JSON.stringify(details));
          return '<td><button class="analytics-detail-button" type="button" data-analytics-definition="' + escapeHtml(encoded) + '">View</button></td>';
        }
        if (title === 'session token hotspots' && index === 0) {
          return '<td>' + renderAnalyticsPrimaryCell(cell) + '</td>';
        }
        return '<td>' + escapeHtml(formatAnalyticsTableCell(cell)) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
  }

  function renderAnalyticsPrimaryCell(cell) {
    var parts = String(cell == null ? '' : cell).split('\n');
    var primary = parts.shift() || '';
    var secondary = parts.join(' ').trim();
    return '<div class="analytics-cell-primary">' + escapeHtml(primary) + '</div>'
      + (secondary ? '<div class="analytics-cell-secondary">' + escapeHtml(secondary) + '</div>' : '');
  }

  function renderAnalyticsDefinitionInventory(artifact) {
    var rows = artifact.rows || [];
    if (!rows.length) return '<div class="analytics-caveats">No definitions found.</div>';
    return '<div class="analytics-table-scroll analytics-table-scroll-compact"><table class="analytics-table analytics-table-definitions"><thead><tr>'
      + '<th>Name</th><th>Summary</th><th>Enabled</th><th>Details</th>'
      + '</tr></thead><tbody>' + rows.map(function (row) {
        var details = parseDefinitionDetails(row[3]);
        var encoded = encodeURIComponent(JSON.stringify(details));
        return '<tr>'
          + '<td>' + escapeHtml(row[0] || '') + '</td>'
          + '<td>' + escapeHtml(row[1] || '') + '</td>'
          + '<td>' + escapeHtml(row[2] || 'Yes') + '</td>'
          + '<td><button class="analytics-detail-button" type="button" data-analytics-definition="' + escapeHtml(encoded) + '">View</button></td>'
          + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function renderAnalyticsMcpUsage(artifact) {
    var columns = artifact.columns || [];
    var rows = artifact.rows || [];
    if (!rows.length) return '<div class="analytics-caveats">No MCP servers or tool usage found for this range.</div>';
    return '<div class="analytics-table-scroll analytics-table-scroll-mcp"><table class="analytics-table analytics-table-mcp"><thead><tr>' + columns.map(function (col) {
      return '<th>' + escapeHtml(formatAnalyticsColumnHeading(col)) + '</th>';
    }).join('') + '</tr></thead><tbody>' + rows.map(function (row) {
      var cells = (row || []).slice(0, columns.length);
      var toggleable = (row || [])[columns.length] !== '0';
      return '<tr>' + cells.map(function (cell, index) {
        if (index === 1) return '<td>' + renderMcpEnabledSwitch(cell, cells[0], toggleable) + '</td>';
        return '<td>' + escapeHtml(formatAnalyticsTableCell(cell)) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table></div>';
  }

  function renderMcpEnabledSwitch(value, server, toggleable) {
    var state = String(value || '').toLowerCase();
    if (state !== 'on' && state !== 'off') state = 'off';
    var checked = state === 'on';
    var disabled = toggleable ? '' : ' disabled aria-disabled="true" title="This MCP server was observed in history but is not present in the local registry."';
    return '<button class="analytics-mcp-switch ' + (checked ? 'on' : 'off') + '" type="button" role="switch" aria-checked="' + (checked ? 'true' : 'false') + '" data-analytics-mcp-server="' + escapeHtml(server || '') + '" data-analytics-mcp-enabled="' + (checked ? 'true' : 'false') + '"' + disabled + '>'
      + '<span></span><strong>' + (checked ? 'On' : 'Off') + '</strong></button>';
  }

  function updateMcpSwitchButton(button, enabled) {
    button.classList.toggle('on', enabled);
    button.classList.toggle('off', !enabled);
    button.setAttribute('aria-checked', enabled ? 'true' : 'false');
    button.setAttribute('data-analytics-mcp-enabled', enabled ? 'true' : 'false');
    var label = button.querySelector('strong');
    if (label) label.textContent = enabled ? 'On' : 'Off';
  }

  function setMcpServerEnabled(button) {
    var server = button.getAttribute('data-analytics-mcp-server') || '';
    var nextEnabled = button.getAttribute('data-analytics-mcp-enabled') !== 'true';
    var invoke = tauriInvoke();
    if (!invoke || !server) {
      updateMcpSwitchButton(button, nextEnabled);
      return;
    }
    button.disabled = true;
    button.classList.add('loading');
    invoke('set_mcp_server_enabled', { server: server, enabled: nextEnabled }).then(function () {
      updateMcpSwitchButton(button, nextEnabled);
      button.title = nextEnabled ? 'MCP server enabled' : 'MCP server disabled';
    }).catch(function (err) {
      window.console.warn('Unable to update MCP server state', err);
      button.title = err && err.message ? err.message : String(err || 'Unable to update MCP server state');
    }).finally(function () {
      button.disabled = false;
      button.classList.remove('loading');
    });
  }

  function formatAnalyticsColumnHeading(value) {
    return String(value == null ? '' : value).replace(/(^|[\s/()-])([a-z])/g, function (_match, prefix, letter) {
      return prefix + letter.toUpperCase();
    });
  }

  function renderAnalyticsColumnHeading(value, artifactTitle) {
    var heading = formatAnalyticsColumnHeading(value);
    if (artifactTitle === 'model shifts' && /^(Current|Previous|Delta) Turns$/.test(heading)) {
      var parts = heading.split(' ');
      return '<span class="analytics-heading-stack"><span>' + escapeHtml(parts[0]) + '</span><span>' + escapeHtml(parts[1]) + '</span></span>';
    }
    if (artifactTitle === 'tool and failure changes' && /^(Current|Previous|Delta) Calls\/Failures?$/.test(heading)) {
      var match = /^(Current|Previous|Delta) Calls\/(Failures?)$/.exec(heading);
      return '<span class="analytics-heading-stack"><span>' + escapeHtml(match[1]) + '</span><span>Calls /</span><span>' + escapeHtml(match[2]) + '</span></span>';
    }
    return escapeHtml(heading);
  }

  function parseDefinitionDetails(value) {
    try {
      return JSON.parse(String(value || '{}')) || {};
    } catch (_err) {
      return {};
    }
  }

  function openAnalyticsDefinitionInEditor(details) {
    var invoke = tauriInvoke();
    if (!invoke) return;
    invoke('open_copilot_definition', {
      kind: details.kind || 'skills',
      definition: details.definition || details.name || '',
      root: details.root || null,
    }).catch(function (err) {
      window.console.warn('Unable to open definition', err);
    });
  }

  function openAnalyticsDefinitionDialog(details) {
    var overlay = document.createElement('section');
    overlay.className = 'analytics-definition-overlay visible';
    overlay.setAttribute('aria-hidden', 'false');
    var definitionLabel = details.kind === 'agents' ? 'Agent' : 'Skill';
    var definitionTitle = (details.name || 'Definition') + ' ' + definitionLabel;
    var completenessLabel = details.scoreLabel || (String(details.score || 0) + '/' + String(details.maxScore || 5));
    overlay.innerHTML = '<div class="analytics-definition-dialog" role="dialog" aria-modal="true" aria-labelledby="analytics-definition-title" tabindex="-1">'
      + '<div class="inspector-header"><div><h2 id="analytics-definition-title" class="inspector-title">' + escapeHtml(definitionTitle) + '</h2></div>'
      + '<button class="inspector-close" type="button" data-analytics-definition-close aria-label="Close definition details">×</button></div>'
      + '<dl class="analytics-definition-details">'
      + '<dt>Summary</dt><dd>' + escapeHtml(details.summary || 'No summary available.') + '</dd>'
      + '<dt>Source</dt><dd>' + escapeHtml(details.root || 'unknown') + '</dd>'
      + '<dt>Size</dt><dd>' + escapeHtml(compactNumber(details.size || 0) + ' chars') + '</dd>'
      + '<dt>Description</dt><dd>' + escapeHtml(compactNumber(details.descriptionChars || 0) + ' chars') + '</dd>'
      + '<dt>Readiness score</dt><dd>' + escapeHtml(completenessLabel) + '</dd>'
      + (details.readiness ? '<dt>Readiness</dt><dd>' + escapeHtml(details.readiness) + '</dd>' : '')
      + '<dt>Issues</dt><dd>' + escapeHtml(details.issues || 'No issues detected.') + '</dd>'
      + '</dl><section class="analytics-definition-source"><h3>Definition</h3><pre data-analytics-definition-source>Loading definition…</pre></section></div>';
    document.body.appendChild(overlay);
    var close = function () { overlay.remove(); };
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay || (event.target && event.target.closest && event.target.closest('[data-analytics-definition-close]'))) close();
    });
    var dialog = overlay.querySelector('.analytics-definition-dialog');
    if (dialog && dialog.focus) dialog.focus();
    loadAnalyticsDefinitionSource(overlay, details);
  }

  function loadAnalyticsDefinitionSource(overlay, details) {
    var target = overlay.querySelector('[data-analytics-definition-source]');
    if (!target) return;
    var invoke = tauriInvoke();
    if (!invoke) {
      target.textContent = 'Definition content is only available in the desktop app.';
      target.scrollTop = 0;
      return;
    }
    invoke('read_copilot_definition', {
      kind: details.kind || 'skills',
      definition: details.definition || details.name || '',
      root: details.root || null,
    }).then(function (payload) {
      target.textContent = formatDefinitionSource(payload, details.kind || 'skills');
      target.scrollTop = 0;
    }).catch(function (err) {
      target.textContent = 'Unable to load definition: ' + String(err && err.message ? err.message : err);
      target.scrollTop = 0;
    });
  }

  function formatDefinitionSource(payload, kind) {
    var container = payload && (payload.skill || payload.agent || payload.definition || payload[kind === 'agents' ? 'agent' : 'skill']);
    var files = (container && container.files) || [];
    if (!files.length) return 'No definition content was returned.';
    return files.map(function (file) {
      var header = file.relative_path || 'definition';
      var content = file.content || '';
      var suffix = file.truncated ? '\n\n[truncated]' : '';
      return '--- ' + header + ' ---\n' + content + suffix;
    }).join('\n\n');
  }

  function formatAnalyticsTableCell(cell) {
    if (typeof cell === 'number') return exactNumber(cell);
    var value = String(cell == null ? '' : cell);
    if (/^[+-]?\d+$/.test(value)) {
      var prefix = value.charAt(0) === '+' || value.charAt(0) === '-' ? value.charAt(0) : '';
      var digits = prefix ? value.slice(1) : value;
      if (digits.length > 3) return prefix + Number(digits).toLocaleString();
    }
    return value;
  }

  function renderAnalyticsBars(points) {
    if (!points.length) return '<div class="analytics-caveats">No trend points for this range.</div>';
    var max = points.reduce(function (m, point) { return Math.max(m, Number(point.output_tokens || 0), Number(point.tool_calls || 0)); }, 1);
    return '<div class="analytics-bars">' + points.map(function (point) {
      var value = Number(point.output_tokens || 0);
      var pct = Math.max(4, Math.min(100, Math.round((value / max) * 100)));
      return '<div class="analytics-bar-row">'
        + '<span>' + escapeHtml(point.local_day || '') + '</span>'
        + '<span class="analytics-bar"><span style="width:' + pct + '%"></span></span>'
        + '<span>' + escapeHtml(exactNumber(value)) + '</span>'
        + '</div>';
    }).join('') + '</div>';
  }

  function renderAnalyticsValueBars(artifact) {
    var rows = (artifact && artifact.rows) || [];
    var valueHeader = ((artifact && artifact.columns && artifact.columns[2]) || '').toLowerCase();
    var valueSuffix = valueHeader.indexOf('char') >= 0 ? ' chars' : '';
    var parsed = rows.map(function (row) {
      var cells = row || [];
      var value = Number(cells[2] || 0);
      return {
        label: String(cells[0] || ''),
        category: String(cells[1] || ''),
        value: Number.isFinite(value) ? value : 0,
      };
    }).filter(function (row) { return row.label && row.value > 0; });
    if (!parsed.length) return '<div class="analytics-caveats">No values for this artifact.</div>';
    var max = parsed.reduce(function (m, row) { return Math.max(m, row.value); }, 1);
    return '<div class="analytics-bars">' + parsed.map(function (row) {
      var pct = Math.max(4, Math.min(100, Math.round((row.value / max) * 100)));
      return '<div class="analytics-bar-row">'
        + '<span title="' + escapeHtml(row.category) + '">' + escapeHtml(row.label) + '</span>'
        + '<span class="analytics-bar"><span style="width:' + pct + '%"></span></span>'
        + '<span title="' + escapeHtml(exactNumber(row.value) + valueSuffix) + '">' + escapeHtml(compactNumber(row.value) + valueSuffix) + '</span>'
        + '</div>';
    }).join('') + '</div>';
  }

  function renderAnalyticsCards(cards) {
    if (!cards.length) return '<div class="analytics-caveats">No recommendations yet.</div>';
    return '<div class="analytics-card-list">' + cards.map(function (card) {
      return '<div class="analytics-card"><strong>' + escapeHtml(card.title || 'Recommendation') + '</strong>'
        + escapeHtml(card.body || '').replace(/\n/g, '<br>') + '</div>';
    }).join('') + '</div>';
  }

  function loadAnalyticsStatus() {
    callAnalyticsCommand('get_analytics_status').then(function (status) {
      renderAnalyticsStatus(status);
    }).catch(function (err) {
      renderAnalyticsStatus({
        available: false,
        privacy_summary: defaultAnalyticsStatus().privacy_summary,
        warnings: [err && err.message ? err.message : String(err || 'Unable to load analytics status')],
      });
    });
  }

  function historyAnalyticsIsFresh() {
    return !!historyAnalyticsSummary && Date.now() - historyAnalyticsLoadedAtMs < HISTORY_ROUTE_CACHE_MS;
  }

  function loadHistoryAnalyticsSummary(force) {
    if (historyAnalyticsLoading) return;
    if (!force && historyAnalyticsIsFresh()) return;
    historyAnalyticsLoading = true;
    historyAnalyticsError = '';
    callAnalyticsCommand('get_analytics_usage_summary', {
      request: { rangeDays: HISTORY_ANALYTICS_RANGE_DAYS, comparePrevious: false },
    }).then(function (summary) {
      historyAnalyticsSummary = summary || defaultAnalyticsUsageSummary();
      historyAnalyticsLoadedAtMs = Date.now();
    }).catch(function (err) {
      historyAnalyticsSummary = defaultAnalyticsUsageSummary();
      historyAnalyticsLoadedAtMs = Date.now();
      historyAnalyticsError = err && err.message ? err.message : String(err || 'Unable to load indexed analytics');
    }).then(function () {
      historyAnalyticsLoading = false;
      liveFingerprints.history = '';
      if (appRoute === 'history') renderHistory(lastDashboard, true);
    });
  }

  function flightLogFingerprint() {
    if (flightLogLoading) return 'loading|' + flightLogSelectedDay + '|' + flightLogMonth;
    if (flightLogError) return 'error|' + flightLogError + '|' + flightLogSelectedDay + '|' + flightLogMonth;
    var digest = flightLogDigest || {};
    var day = digest.day || {};
    return [
      digest.generated_at_ms || 0,
      digest.selected_day || flightLogSelectedDay,
      digest.month || flightLogMonth,
      (digest.calendar_days || []).map(function (item) {
        return [item.local_day, item.events, item.failures, item.intensity, (item.badges || []).join(',')].join(':');
      }).join('|'),
      (day.repos || []).map(function (repo) { return repo.repository + ':' + repo.branch + ':' + repo.events; }).join('|'),
      (day.tools || []).map(function (tool) { return tool.name + ':' + tool.calls + ':' + tool.failures; }).join('|'),
      (day.failures || []).map(function (failure) { return failure.tool + ':' + failure.count; }).join('|'),
    ].join('||');
  }

  function loadFlightLogDigest(force) {
    if (flightLogLoading && !force) return;
    if (!force && flightLogDigest && flightLogDigest.selected_day === flightLogSelectedDay && flightLogDigest.month === flightLogMonth) return;
    var requestSeq = ++flightLogRequestSeq;
    var requestedDay = flightLogSelectedDay;
    var requestedMonth = flightLogMonth;
    flightLogLoading = true;
    flightLogError = '';
    if (appRoute === 'history' && historyTab === 'flight-log') renderHistory(lastDashboard, true);
    callAnalyticsCommand('get_engineering_digest', {
      request: {
        selected_day: requestedDay,
        month: requestedMonth,
      },
    }).then(function (digest) {
      if (requestSeq !== flightLogRequestSeq) return;
      flightLogDigest = digest || defaultEngineeringDigest({ selected_day: requestedDay, month: requestedMonth });
      flightLogSelectedDay = flightLogDigest.selected_day || flightLogSelectedDay;
      flightLogMonth = flightLogDigest.month || flightLogMonth;
      flightLogCopyStatus = '';
    }).catch(function (err) {
      if (requestSeq !== flightLogRequestSeq) return;
      flightLogDigest = defaultEngineeringDigest({ selected_day: requestedDay, month: requestedMonth });
      flightLogError = err && err.message ? err.message : String(err || 'Unable to load Daily Log');
    }).then(function () {
      if (requestSeq !== flightLogRequestSeq) return;
      flightLogLoading = false;
      liveFingerprints.history = '';
      if (appRoute === 'history' && historyTab === 'flight-log') renderHistory(lastDashboard, true);
    });
  }

  function hasHistoryAnalyticsSummary(summary) {
    return !!(summary && Array.isArray(summary.metrics) && summary.metrics.length > 0);
  }

  window.__cmcAnalyticsStatusChanged = function () {
    if (appRoute === 'analytics') loadAnalyticsStatus();
    if (appRoute === 'history') loadHistoryAnalyticsSummary(true);
  };

  window.__cmcAnalyticsChatToolStarted = function (toolName) {
    if (!analyticsChatLoading || !analyticsChatMessages.length) return;
    var last = analyticsChatMessages[analyticsChatMessages.length - 1];
    if (!last || last.role !== 'assistant') return;
    var label = String(toolName || '').trim();
    if (!label) return;
    last.toolCalls = last.toolCalls || [];
    if (last.toolCalls.indexOf(label) < 0) {
      last.toolCalls.push(label);
      renderAnalyticsChat();
    }
  };

  function askAnalytics(prompt) {
    var question = String(prompt || '').trim();
    if (!question || analyticsChatLoading) return;
    var requestSeq = ++analyticsChatRequestSeq;
    analyticsChatLoading = true;
    analyticsChatMessages.push({ role: 'user', text: question, entering: true });
    analyticsChatMessages.push({
      role: 'assistant',
      text: analyticsStatusCache && analyticsStatusCache.ingestion_running
        ? 'Analyzing Copilot history… I can answer from the data indexed so far.'
        : 'Checking local analytics…',
      loading: true,
      entering: true,
    });
    renderAnalyticsChat();
    if (analyticsChatInput && analyticsChatInput.value.trim() === question) {
      analyticsChatInput.value = '';
    }
    callAnalyticsCommand('ask_analytics_chat', { request: { prompt: question, rangeDays: 7 } }).then(function (response) {
      if (requestSeq !== analyticsChatRequestSeq) return;
      analyticsChatMessages[analyticsChatMessages.length - 1] = {
        role: 'assistant',
        text: response.answer || 'No analytics answer was returned.',
        artifacts: response.artifacts || [],
        caveats: response.caveats || [],
      };
      analyticsChatLoading = false;
      renderAnalyticsChat();
    }).catch(function (err) {
      if (requestSeq !== analyticsChatRequestSeq) return;
      analyticsChatMessages[analyticsChatMessages.length - 1] = {
        role: 'assistant',
        text: 'Analytics chat failed: ' + (err && err.message ? err.message : String(err || 'unknown error')),
      };
      analyticsChatLoading = false;
      renderAnalyticsChat();
    });
  }

  function loadAnalyticsRoute(options) {
    renderAnalyticsSuggestions();
    renderAnalyticsStatus(analyticsStatusCache || defaultAnalyticsStatus());
    renderAnalyticsChat();
    loadAnalyticsStatus();
    maybeShowAnalyticsTokenNotice(analyticsRouteBtn);
    if (options && options.focus && analyticsChatInput && typeof analyticsChatInput.focus === 'function') {
      analyticsChatInput.focus({ preventScroll: true });
    }
  }

  function unloadAnalyticsRoute() {
    if (analyticsChatScreen) analyticsChatScreen.scrollTop = 0;
  }

  function triggerRouteEnterAnimation(route) {
    var routeTargets = [gameRoot, dashboardOverlay, historyScreen, analyticsChatScreen].filter(Boolean);
    var activeTargets = route === 'history'
      ? [historyScreen]
      : route === 'analytics'
        ? [analyticsChatScreen]
        : [gameRoot, dashboardOverlay];
    routeTargets.forEach(function (el) {
      el.classList.remove('cmc-route-entering');
    });
    activeTargets.forEach(function (el) {
      if (!el) return;
      void el.offsetWidth;
      el.classList.add('cmc-route-entering');
    });
  }

  function applyAppRoute(route, options) {
    var next = route === 'history' ? 'history' : (route === 'analytics' ? 'analytics' : 'mission');
    var previous = appRoute;
    appRoute = next;
    document.body.classList.toggle('history-route', appRoute === 'history');
    document.body.classList.toggle('analytics-route', appRoute === 'analytics');
    setRouteButtonState(missionRouteBtn, appRoute === 'mission');
    setRouteButtonState(historyRouteBtn, appRoute === 'history');
    setRouteButtonState(analyticsRouteBtn, appRoute === 'analytics');
    applyPanelsState();
    if (historyScreen) historyScreen.setAttribute('aria-hidden', appRoute === 'history' ? 'false' : 'true');
    if (analyticsChatScreen) analyticsChatScreen.setAttribute('aria-hidden', appRoute === 'analytics' ? 'false' : 'true');
    [gameRoot, dashboardOverlay, domLoading].forEach(function (el) {
      if (el) el.setAttribute('aria-hidden', appRoute === 'mission' ? 'false' : 'true');
    });
    if (previous !== appRoute) triggerRouteEnterAnimation(appRoute);
    if (!options || options.syncHash !== false) syncRouteHash(appRoute);
    if (appRoute === 'history') {
      if (previous === 'analytics') unloadAnalyticsRoute();
      var historyDashboard = historyDashboardForRoute(lastDashboard);
      if (historyDashboard) {
        renderHistory(historyDashboard, previous !== 'history');
      } else {
        renderHistory(null, true);
      }
      scheduleHistoryFetch();
      if (options && options.focus && historyScreen && typeof historyScreen.focus === 'function') {
        historyScreen.focus({ preventScroll: true });
      }
    } else if (appRoute === 'analytics') {
      if (previous === 'history') unloadHistoryRoute();
      loadAnalyticsRoute(options || {});
    } else if (previous === 'history' || previous === 'analytics') {
      if (previous === 'history') unloadHistoryRoute();
      if (previous === 'analytics') unloadAnalyticsRoute();
      window.requestAnimationFrame(function () {
        if (appRoute === 'mission' && lastDashboard && typeof window.__cmcRenderDashboard === 'function') {
          window.__cmcRenderDashboard(lastDashboard);
        }
      });
    }
  }

  function navigateAppRoute(route, focus) {
    applyAppRoute(route, { syncHash: true, focus: focus !== false });
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

  function markDashboardReady(view) {
    if (!view || !view.initialActivityLoaded) return;
    document.body.classList.add('dashboard-ready');
    requestDashboardSplashHide();
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
    edits: '#f0911d',
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
    edits: 'Edits',
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

  function naturalPanelHeight(el, fallback) {
    if (!el) return 0;
    var rectH = Math.ceil(el.getBoundingClientRect().height || 0);
    var scrollH = Math.ceil(el.scrollHeight || 0);
    return Math.max(rectH, scrollH, fallback || 0);
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

  function tokenLabel(input, output, inputPending) {
    var inTok = Number(input || 0);
    var outTok = Number(output || 0);
    var inputLabel = inputPending
      ? '<span class="cmc-token-pending" title="Input token totals are pending because Copilot CLI emits output tokens during each turn, but input tokens usually arrive later in aggregate usage summaries or session shutdown events.">pending</span>'
      : exactNumber(inTok);
    return inputLabel + ' / ' + exactNumber(outTok);
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
    var shortId = opt && opt.id === '__all_sessions__' ? '' : (opt && (opt.shortId || (opt.id || '').slice(0, 8))) || '';
    var repository = cleanSessionLabel(opt && opt.repository);
    var branch = cleanSessionLabel(opt && opt.branch);
    var title = cleanSessionLabel(opt && opt.title);
    var sessionName = cleanSessionLabel(opt && opt.sessionName);
    var main = sessionName || title || repository || (shortId ? 'Session ' + shortId : 'session');
    var scope = [repository, branch].filter(Boolean).join(' ');
    var subParts = [];
    if (scope && scope !== main) subParts.push(scope);
    if (shortId) subParts.push(shortId);
    if (subParts.length) {
      return {
        main: marker + main,
        sub: subParts.join(' · '),
      };
    }
    return {
      main: marker + main,
      sub: '',
    };
  }

  function renderSessionOption(opt) {
    var lines = sessionOptionLines(opt || {});
    var statusLabel = opt && opt.statusLabel;
    return '<span class="cmc-session-option-text">'
      + '<span class="cmc-session-option-main"><span>' + escapeHtml(lines.main) + '</span>'
      + (statusLabel ? '<span class="cmc-session-status-label">' + escapeHtml(statusLabel) + '</span>' : '')
      + '</span>'
      + (lines.sub ? '<span class="cmc-session-option-sub">' + escapeHtml(lines.sub) + '</span>' : '')
      + '</span>';
  }

  function selectedSessionHeading(session) {
    if (!session) return { title: '', subtitle: '' };
    var shortId = shortSessionId(session.id);
    var sessionName = cleanSessionLabel(session.session_name);
    var title = cleanSessionLabel(session.title);
    var repository = cleanSessionLabel(session.repository);
    var branch = cleanSessionLabel(session.branch);
    var heading = sessionName || title || repository || 'Session ' + shortId;
    var scope = [repository, branch].filter(Boolean).join(' / ');
    return { title: heading, subtitle: scope && scope !== heading ? scope : '' };
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

  function attentionSeverityColor(severity) {
    if (severity === 'critical') return '#ff5252';
    if (severity === 'review') return '#ffd54a';
    if (severity === 'watch') return '#61d6ff';
    return '#60ff9a';
  }

  function renderAttentionEntry(attention) {
    var state = attention || { count: 0, summary: 'No action needed', highestSeverity: 'info' };
    var count = Number(state.count || 0);
    var severity = state.highestSeverity || (count > 0 ? 'watch' : 'info');
    if (count <= 0) {
      return '<div class="cmc-attention-entry quiet" role="status">'
        + '<span class="cmc-attention-copy">'
        + '<span class="cmc-attention-kicker">Attention</span>'
        + '<span class="cmc-attention-summary">' + escapeHtml(state.summary || 'No action needed') + '</span>'
        + '</span>'
        + '</div>';
    }
    return '<button class="cmc-attention-entry ' + escapeHtml(severity) + '" type="button" data-cmc-action="attention-center" aria-haspopup="dialog">'
      + '<span class="cmc-attention-copy">'
      + '<span class="cmc-attention-kicker">Attention</span>'
      + '<span class="cmc-attention-summary">' + escapeHtml(state.summary || 'No action needed') + '</span>'
      + '</span>'
      + '<span class="cmc-attention-count">' + escapeHtml(String(count)) + '</span>'
      + '</button>';
  }

  function activitySignal(view) {
    return view && view.activitySignal || null;
  }

  function selectedActivityRateSignal(view) {
    var selected = view && view.sessions && view.sessions.selected;
    if (!selected) return activitySignal(view) || null;
    var selectedSignal = selected.activity_signal;
    var selectedHasSignal = !!(
      selectedSignal
      && Array.isArray(selectedSignal.hourly_24h)
      && selectedSignal.hourly_24h.length
      && (
        Number(selectedSignal.launches_last_5m || 0) > 0
        || Number(selectedSignal.launches_last_hour || 0) > 0
        || Number(selectedSignal.peak_velocity_per_hour || 0) > 0
        || selectedSignal.hourly_24h.some(function (bucket) { return Number(bucket.event_count || 0) > 0; })
      )
    );
    if (selectedHasSignal) {
      return selected.activity_signal;
    }
    var globalSignal = activitySignal(view) || {};
    var latestSelectedActivityMs = 0;
    (selected.recent_tool_calls || []).forEach(function (call) {
      var timestamp = Date.parse(call.timestamp || '');
      if (Number.isFinite(timestamp)) latestSelectedActivityMs = Math.max(latestSelectedActivityMs, timestamp);
    });
    (selected.recent_turns || []).forEach(function (turn) {
      var timestamp = Date.parse(turn.started_at || turn.ended_at || '');
      if (Number.isFinite(timestamp)) latestSelectedActivityMs = Math.max(latestSelectedActivityMs, timestamp);
    });
    var generatedAtMs = Math.max(Number(globalSignal.generated_at_ms || 0), latestSelectedActivityMs) || Date.now();
    var hourMs = 60 * 60 * 1000;
    var endBucketStart = Math.floor(generatedAtMs / hourMs) * hourMs;
    var buckets = Array.from({ length: 24 }, function (_, index) {
      var startMs = endBucketStart - (23 - index) * hourMs;
      var date = new Date(startMs);
      return {
        start: date.toISOString().replace('.000Z', 'Z'),
        label: String(date.getUTCHours()).padStart(2, '0') + ':00Z',
        event_count: 0,
        launch_count: 0,
        turn_count: 0,
        failure_count: 0,
        active_sessions: 0,
        intensity: 0,
      };
    });
    var bucketIndexByStart = new Map(buckets.map(function (bucket, index) { return [bucket.start, index]; }));
    var seen = new Set();
    var fiveMinStart = generatedAtMs - 5 * 60 * 1000;
    var hourStart = generatedAtMs - hourMs;
    var activityLast5m = 0;
    var activityLastHour = 0;
    (selected.recent_tool_calls || []).forEach(function (call) {
      var timestamp = Date.parse(call.timestamp || '');
      if (!Number.isFinite(timestamp)) return;
      var key = [selected.id || '', call.timestamp || '', call.tool || '', call.category || '', call.call_id || ''].join('\u001f');
      if (seen.has(key)) return;
      seen.add(key);
      var bucketStart = Math.floor(timestamp / hourMs) * hourMs;
      var bucketKey = new Date(bucketStart).toISOString().replace('.000Z', 'Z');
      var bucketIndex = bucketIndexByStart.get(bucketKey);
      if (bucketIndex != null) {
        var bucket = buckets[bucketIndex];
        bucket.event_count += 1;
        bucket.launch_count += 1;
        if (!call.success) bucket.failure_count += 1;
        if (bucket.event_count > 0) bucket.active_sessions = 1;
      }
      if (timestamp >= fiveMinStart && timestamp <= generatedAtMs) activityLast5m += 1;
      if (timestamp >= hourStart && timestamp <= generatedAtMs) activityLastHour += 1;
    });
    (selected.recent_turns || []).forEach(function (turn) {
      var timestamp = Date.parse(turn.started_at || turn.ended_at || '');
      if (!Number.isFinite(timestamp)) return;
      var key = [selected.id || '', turn.id || '', turn.started_at || '', turn.ended_at || ''].join('\u001f');
      if (seen.has(key)) return;
      seen.add(key);
      var bucketStart = Math.floor(timestamp / hourMs) * hourMs;
      var bucketKey = new Date(bucketStart).toISOString().replace('.000Z', 'Z');
      var bucketIndex = bucketIndexByStart.get(bucketKey);
      if (bucketIndex != null) {
        var bucket = buckets[bucketIndex];
        bucket.event_count += 1;
        bucket.turn_count += 1;
        bucket.failure_count += Number(turn.failure_count || 0) > 0 ? 1 : 0;
        if (bucket.event_count > 0) bucket.active_sessions = 1;
      }
      if (timestamp >= fiveMinStart && timestamp <= generatedAtMs) activityLast5m += 1;
      if (timestamp >= hourStart && timestamp <= generatedAtMs) activityLastHour += 1;
    });
    var peakActivity = buckets.reduce(function (max, bucket) { return Math.max(max, bucket.event_count); }, 0);
    buckets.forEach(function (bucket) {
      bucket.intensity = peakActivity > 0 && bucket.event_count > 0 ? bucket.event_count / peakActivity : 0;
    });
    return {
      generated_at_ms: generatedAtMs,
      launches_last_5m: activityLast5m,
      launches_last_hour: activityLastHour,
      velocity_per_hour: activityLastHour,
      peak_velocity_per_hour: peakActivity,
      active_hours_24h: buckets.filter(function (bucket) { return bucket.event_count > 0; }).length,
      hourly_24h: buckets,
    };
  }

  function formatRate(value) {
    var numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return 'idle';
    var label = numeric >= 10 ? Math.round(numeric).toLocaleString() : numeric.toFixed(1).replace(/\.0$/, '');
    return label + ' activit' + (Number(label) === 1 ? 'y' : 'ies') + '/hr';
  }

  function tempoIntensityLevel(value) {
    var numeric = Number(value || 0);
    if (numeric <= 0) return 0;
    if (numeric < 0.25) return 1;
    if (numeric < 0.5) return 2;
    if (numeric < 0.75) return 3;
    return 4;
  }

  function tempoBucketLocalLabel(bucket) {
    var local = bucket && bucket.start ? formatHistoryAxisTime(Date.parse(bucket.start)) : '';
    return local || (bucket && bucket.label) || '';
  }

  function tempoBucketLocalRange(bucket) {
    var startMs = bucket && bucket.start ? Date.parse(bucket.start) : NaN;
    if (!Number.isFinite(startMs)) return tempoBucketLocalLabel(bucket);
    var endMs = startMs + 60 * 60 * 1000;
    var start = formatHistoryAxisTime(startMs);
    var end = formatHistoryAxisTime(endMs);
    if (!start || !end) return tempoBucketLocalLabel(bucket);
    return start + ' - ' + end;
  }

  function tempoBucketReadout(bucket, index, mode) {
    var label = tempoBucketLocalRange(bucket);
    var base = (label || 'Hour ' + (index + 1)) + ': ';
    if (mode === 'activity') {
      return base
        + countLabel(Number(bucket && bucket.event_count || 0), 'activity item', 'activity items') + ', '
        + countLabel(Number(bucket && bucket.launch_count || 0), 'tool call', 'tool calls') + ', '
        + countLabel(Number(bucket && bucket.turn_count || 0), 'turn', 'turns');
    }
    var failures = Number(bucket && bucket.failure_count || 0);
    if (mode === false) {
      return base
        + countLabel(Number(bucket && bucket.event_count || 0), 'event', 'events') + ', '
        + countLabel(Number(bucket && bucket.active_sessions || 0), 'session', 'sessions')
        + (failures > 0 ? ', ' + countLabel(failures, 'failure', 'failures') : '');
    }
    return base
      + countLabel(Number(bucket && bucket.launch_count || 0), 'agent start', 'agent starts') + ', '
      + countLabel(Number(bucket && bucket.event_count || 0), 'event', 'events')
      + (failures > 0 ? ', ' + countLabel(failures, 'failure', 'failures') : '');
  }

  function renderTempoHeatStrip(buckets, className, mode) {
    var rows = Array.isArray(buckets) ? buckets.slice(-24) : [];
    if (!rows.length) return '';
    return '<div class="' + escapeHtml(className || 'cmc-tempo-heat-strip') + '" aria-label="Recent activity density">'
      + rows.map(function (bucket, index) {
        var level = tempoIntensityLevel(bucket && bucket.intensity);
        var title = tempoBucketReadout(bucket, index, mode || true);
        return '<span class="cmc-tempo-heat-cell" data-intensity="' + level + '" data-tempo-readout="' + escapeHtml(title) + '" title="' + escapeHtml(title) + '" tabindex="0" aria-label="' + escapeHtml(title) + '"></span>';
      }).join('')
      + '</div>';
  }

  function renderOpsTempo(view) {
    var signal = selectedActivityRateSignal(view) || {};
    var activity5m = Number(signal.launches_last_5m || 0);
    var activityHour = Number(signal.launches_last_hour || 0);
    var velocity = Number(signal.velocity_per_hour || activityHour || 0);
    var peak = Number(signal.peak_velocity_per_hour || 0);
    var activeHours = Number(signal.active_hours_24h || 0);
    var state = activity5m > 0 ? 'active' : 'quiet';
    var velocityLabel = formatRate(velocity);
    var startsLabel = exactNumber(activity5m) + ' activit' + (activity5m === 1 ? 'y' : 'ies');
    var peakHtml = peak > 0 ? '<span class="cmc-ops-tempo-note">Peak hour ' + escapeHtml(formatRate(peak)) + '</span>' : '';
    return '<div class="cmc-ops-tempo ' + escapeHtml(state) + '" aria-label="Live operations tempo">'
      + '<div class="cmc-ops-tempo-head"><span>Activity Rate</span></div>'
      + '<div class="cmc-ops-tempo-grid">'
      + '<div class="cmc-ops-tempo-metric"><span>Past hour</span><strong>' + escapeHtml(velocityLabel) + '</strong></div>'
      + '<div class="cmc-ops-tempo-metric"><span>Past 5 min</span><strong>' + escapeHtml(startsLabel) + '</strong></div>'
      + '</div>'
      + renderTempoHeatStrip(signal.hourly_24h, 'cmc-tempo-heat-strip', 'activity')
      + '<div class="cmc-tempo-readout" aria-live="polite">Hover an hour for tool calls and turns.</div>'
      + '<div class="cmc-ops-tempo-foot">' + peakHtml + '<span class="cmc-ops-tempo-note">' + escapeHtml(exactNumber(activeHours) + '/24 active hours') + '</span></div>'
      + '</div>';
  }

  function updateTempoReadout(target) {
    if (!target || typeof target.closest !== 'function') return;
    var point = target.closest('[data-tempo-readout]');
    if (!point) return;
    var card = point.closest('.cmc-ops-tempo');
    var readout = card && card.querySelector('.cmc-tempo-readout');
    var text = point.getAttribute('data-tempo-readout') || '';
    if (readout && text) {
      readout.textContent = text;
      readout.classList.add('visible');
    }
  }

  function hideTempoReadout(target) {
    if (!target || typeof target.closest !== 'function') return;
    var card = target.closest('.cmc-ops-tempo');
    var readout = card && card.querySelector('.cmc-tempo-readout');
    if (readout) {
      readout.textContent = 'Hover an hour for tool calls and turns.';
      readout.classList.remove('visible');
    }
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
      body.innerHTML = alertsHtml + renderOpsTempo(view) + '<div class="cmc-label">No running Copilot sessions found. Start Copilot CLI and this panel will show the active task.</div>';
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
      var inputPending = !!selected.input_tokens_pending || (!selected.replay_activity && inTok <= 0 && outTok > 0);
      var tcalls = (selected.recent_tool_calls || []).length;
      var isAggregate = !!selected.is_all_sessions;
      var hasGitRoot = !!selected.git_root && !isAggregate;
      var canInspect = tcalls > 0 && !isAggregate;
      var activity = selected.replay_activity || selectedActivity(selected);
      var heading = selectedSessionHeading(selected);
      var model = selected.last_model || '';
      var modelLabel = modelLabelText(model);
      var actionsHtml = isAggregate
        ? ''
        : '<div class="cmc-actions">'
          + '<button class="cmc-button accent ' + (hasGitRoot ? '' : 'disabled') + '" aria-label="Open selected session in editor" ' + (hasGitRoot ? 'data-cmc-action="editor"' : 'disabled aria-disabled="true"') + '>↗ Open in Editor</button>'
          + '<button class="cmc-button ' + (canInspect ? '' : 'disabled') + '" aria-label="Open inspector for selected session" ' + (canInspect ? 'data-cmc-action="inspector"' : 'disabled aria-disabled="true"') + '>Inspector</button>'
          + '</div>';
      selectedHtml = '<div class="cmc-session-summary">'
        + '<div class="cmc-session-heading">'
        + '<div>'
        + '<div class="cmc-session-title" title="' + escapeHtml(heading.title) + '">' + escapeHtml(heading.title) + '</div>'
        + (heading.subtitle ? '<div class="cmc-session-subtitle" title="' + escapeHtml(heading.subtitle) + '">' + escapeHtml(heading.subtitle) + '</div>' : '')
        + '</div>'
        + '</div>'
        + '<div class="cmc-session-meta">'
        + '<span class="cmc-meta-label">Last: ' + escapeHtml(activity.last) + '</span>'
        + '<span class="cmc-meta-label">Tool: ' + escapeHtml(activity.tool) + '</span>'
        + '<span class="cmc-meta-label">Age: ' + escapeHtml(activity.age) + '</span>'
        + '<span class="cmc-meta-label">Tokens in/out: ' + tokenLabel(inTok, outTok, inputPending) + '</span>'
        + '<span class="cmc-meta-label cmc-model-meta"><span id="model-label">' + modelLabel + ':</span> <span id="model-chip" class="' + (model ? '' : 'empty') + '" title="Active ' + modelLabel.toLowerCase() + ' for the selected session">' + escapeHtml(model) + '</span></span>'
        + '</div>'
        + '</div>'
        + renderOpsTempo(view)
        + actionsHtml;
    }
    body.innerHTML = alertsHtml + picker + selectedHtml;
    if (selected) updateModelChipElement(selected.last_model || '', true);
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

  function recentFeedPanelHeight(view) {
    var rowCount = ((view.feed && view.feed.rows) || []).length;
    if (!rowCount) return 110;
    var visibleRows = Math.min(rowCount, RECENT_ACTIVITY_VISIBLE_ROWS);
    var panelChromeH = 64;
    var bodyPaddingH = 20;
    var rowH = 26;
    var rowGap = 8;
    return panelChromeH + bodyPaddingH + (visibleRows * rowH) + (Math.max(0, visibleRows - 1) * rowGap);
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
    var hideDetails = !!q.detailsDisabled;
    var disabled = count <= 0;
    var actionsHtml = hideDetails ? '' : '<div class="cmc-actions cmc-quarter-actions">'
      + '<button class="cmc-button accent ' + (disabled ? 'disabled' : '') + '" type="button" aria-label="Open details for ' + escapeHtml(q.title || categoryLabel(q.category)) + ' sector" aria-haspopup="dialog" '
      + (disabled ? 'disabled aria-disabled="true"' : 'data-cmc-action="quarter-details"')
      + ' data-sector-category="' + escapeHtml(q.category || '') + '"'
      + ' data-sector-title="' + escapeHtml(q.title || categoryLabel(q.category)) + '"'
      + ' data-sector-count="' + escapeHtml(count) + '"'
      + ' data-sector-color="' + escapeHtml(q.color || CATEGORY_COLORS[q.category] || '#ffd54a') + '">Details</button>'
      + '</div>';
    body.innerHTML = '<div class="cmc-quarter-line">' + escapeHtml(q.countLine) + '</div>'
      + '<div class="cmc-quarter-line">' + escapeHtml(q.line) + '</div>'
      + actionsHtml;
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

  function attentionActionLabel(action) {
    if (action === 'open-schema-drift') return 'View schema details';
    if (action === 'open-inspector') return 'Open inspector';
    if (action === 'select-session') return 'View session';
    return '';
  }

  function renderAttentionDialog(attention) {
    if (!attentionSubtitle || !attentionBody) return;
    var state = attention || { count: 0, empty: 'No action needed.', items: [] };
    var count = Number(state.count || 0);
    attentionSubtitle.textContent = count > 0
      ? 'Reliable signals only. No prompts, tool arguments, command output, file paths, or diffs are shown.'
      : '';
    var items = state.items || [];
    if (!items.length) {
      attentionBody.innerHTML = '<div class="attention-empty">' + escapeHtml(state.empty || 'No action needed.') + '</div>';
      return;
    }
    attentionBody.innerHTML = '<div class="attention-list">' + items.map(function (item) {
      var actionLabel = attentionActionLabel(item.action);
      var actionHtml = actionLabel
        ? '<div class="cmc-actions"><button class="cmc-button accent" type="button" data-attention-action="' + escapeHtml(item.action) + '" data-attention-id="' + escapeHtml(item.id) + '">' + escapeHtml(actionLabel) + '</button></div>'
        : '<div class="cmc-muted">Guidance is shown in the selected session panel when available.</div>';
      return '<article class="attention-item" style="--attention-color:' + attentionSeverityColor(item.severity) + '">'
        + '<div class="attention-item-head">'
        + '<div class="attention-item-title">' + escapeHtml(item.title || 'Attention item') + '</div>'
        + '<div class="attention-tags">'
        + '<span class="attention-tag">' + escapeHtml(item.severity || 'info') + '</span>'
        + '<span class="attention-tag">' + escapeHtml(item.confidence || 'direct') + '</span>'
        + '<span class="attention-tag">' + escapeHtml(item.source || 'session') + '</span>'
        + '</div>'
        + '</div>'
        + '<div class="attention-item-detail">' + escapeHtml(item.detail || '') + '</div>'
        + actionHtml
        + '</article>';
    }).join('') + '</div>';
  }

  function openAttentionCenter(returnFocus) {
    if (!attentionOverlay) return;
    attentionReturnFocus = returnFocus || document.activeElement;
    renderAttentionDialog(lastDashboard && lastDashboard.attention);
    attentionOverlay.classList.add('visible');
    attentionOverlay.setAttribute('aria-hidden', 'false');
    if (attentionDialog && attentionDialog.focus) attentionDialog.focus();
  }

  function closeAttentionCenter() {
    if (!attentionOverlay) return;
    attentionOverlay.classList.remove('visible');
    attentionOverlay.setAttribute('aria-hidden', 'true');
    if (attentionReturnFocus && attentionReturnFocus.focus) attentionReturnFocus.focus();
    attentionReturnFocus = null;
  }

  function attentionItemById(id) {
    var items = lastDashboard && lastDashboard.attention && lastDashboard.attention.items;
    return (items || []).find(function (item) { return item.id === id; }) || null;
  }

  function openSelectedInspectorAfterRender() {
    window.setTimeout(function () {
      var selected = lastDashboard && lastDashboard.sessions && lastDashboard.sessions.selected;
      if (selected) openInspector(selected, null);
    }, 0);
  }

  function runAttentionAction(item) {
    if (!item) return;
    if (item.action === 'open-schema-drift') {
      var report = lastDashboard && lastDashboard.schemaDrift && lastDashboard.schemaDrift[0];
      closeAttentionCenter();
      if (report) renderSchemaDriftDialog(report);
      return;
    }
    if (item.sessionId && typeof window.__cmcSelectSession === 'function') {
      window.__cmcSelectSession(item.sessionId);
    }
    if (item.action === 'open-inspector') {
      closeAttentionCenter();
      openSelectedInspectorAfterRender();
      return;
    }
    if (item.action === 'select-session') {
      closeAttentionCenter();
    }
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
          opt.statusLabel || '',
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
      attentionFingerprint(view),
    ].join('::');
  }

  function attentionFingerprint(view) {
    var attention = (view && view.attention) || {};
    var items = attention.items || [];
    return [
      attention.count || 0,
      attention.highestSeverity || '',
      attention.summary || '',
      attention.empty || '',
      items.map(function (item) {
        return [
          item.id || '',
          item.severity || '',
          item.confidence || '',
          item.source || '',
          item.sessionId || '',
          item.title || '',
          item.detail || '',
          item.action || '',
          item.timestamp || '',
        ].join(':');
      }).join('|'),
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
      'Agent Mission Control detected local Copilot CLI events that do not match the current parser/schema assumptions.',
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
    return 'https://github.com/DanWahlin/agent-mission-control/issues/new?'
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
      dismissed = safeGet(STORAGE_KEYS.schemaDriftDismissed);
    } catch (_err) {
      dismissed = '';
    }
    if (!fingerprint || fingerprint === lastSchemaDriftFingerprint || fingerprint === dismissed) return;
    lastSchemaDriftFingerprint = fingerprint;
    renderSchemaDriftDialog(report);
  }

  function historyFingerprint(view) {
    var history = view && view.history;
    if (!history) return view ? 'unavailable' : 'loading';
    return [
      historySessionFilter,
      historyAnalyticsLoading ? 'analytics-loading' : '',
      historyAnalyticsError,
      historyAnalyticsSummary && historyAnalyticsSummary.generated_at_ms || 0,
      analyticsMetricValue(historyAnalyticsSummary, 'Sessions'),
      analyticsMetricValue(historyAnalyticsSummary, 'Events'),
      analyticsMetricValue(historyAnalyticsSummary, 'Tool calls'),
      analyticsMetricValue(historyAnalyticsSummary, 'Input tokens'),
      analyticsMetricValue(historyAnalyticsSummary, 'Output tokens'),
      history.generated_at_ms || 0,
      history.event_count || 0,
      history.tool_count || 0,
      history.failure_count || 0,
      (history.activity_24h || []).map(function (bucket) { return bucket.event_count + ':' + bucket.failure_count; }).join(','),
      (history.activity_7d || []).map(function (bucket) { return bucket.event_count + ':' + bucket.failure_count; }).join(','),
      (history.model_mix || []).map(function (metric) { return metric.name + ':' + metric.count; }).join(','),
      (history.category_mix || []).map(function (metric) { return metric.name + ':' + metric.count; }).join(','),
      (history.top_tools || []).map(function (metric) { return metric.name + ':' + metric.count; }).join(','),
      (history.recent_sessions || []).map(function (session) { return session.id + ':' + session.event_count + ':' + session.error_count; }).join(','),
      (history.recent_failures || []).map(function (failure) { return failure.session_id + ':' + failure.timestamp + ':' + failure.tool; }).join(','),
      (history.session_scopes || []).map(function (scope) { return scope.session_id + ':' + (scope.event_count || 0) + ':' + (scope.tool_count || 0) + ':' + scope.failure_count + ':' + (scope.recent_failures || []).length; }).join(','),
    ].join('|');
  }

  function historySessionScopes(history) {
    return Array.isArray(history && history.session_scopes) ? history.session_scopes : [];
  }

  function selectedHistorySummary(history) {
    if (!history || historySessionFilter === 'all') return history;
    var scope = historySessionScopes(history).find(function (item) {
      return item && item.session_id === historySessionFilter;
    });
    return scope || history;
  }

  function defaultHistorySubtitle() {
    return 'KPI totals cover indexed local analytics for the last 7 days. Session-filtered views show the selected scanned session.';
  }

  function historySubtitleLabel(view, history, scoped) {
    if (!history) return defaultHistorySubtitle();
    if (scoped) {
      var scopeName = historySessionLabel({
        session_id: history.session_id,
        label: history.label || (history.recent_sessions && history.recent_sessions[0] && history.recent_sessions[0].title) || '',
      });
      return 'KPI totals cover the selected session' + (scopeName ? ' (' + scopeName + ')' : '') + '. Charts below show rolling 24h and last 7 days.';
    }
    if (hasHistoryAnalyticsSummary(historyAnalyticsSummary)) {
      return 'KPI and model totals cover indexed local analytics for the last ' + exactNumber(historyAnalyticsSummary.range_days || HISTORY_ANALYTICS_RANGE_DAYS) + ' days. Session-filtered views show one scanned session.';
    }
    if (historyAnalyticsLoading) {
      return 'Loading indexed local analytics for the last ' + exactNumber(HISTORY_ANALYTICS_RANGE_DAYS) + ' days. Current values use the latest scanned session snapshot.';
    }
    if (historyAnalyticsError) {
      return 'Indexed analytics were unavailable, so KPI totals use the latest scanned session snapshot.';
    }
    var activity = view && view.activity || {};
    var scannedSessions = Number(activity.scannedSessions);
    var sessionCount = Number.isFinite(scannedSessions) && scannedSessions > 0
      ? scannedSessions
      : (history.recent_sessions || []).length || historySessionScopes(history).length;
    var sessionText = sessionCount > 0 ? ' (' + exactNumber(sessionCount) + ' ' + (sessionCount === 1 ? 'session' : 'sessions') + ')' : '';
    return 'KPI totals cover all currently scanned local sessions' + sessionText + '. Charts below show rolling 24h and last 7 days.';
  }

  function analyticsMetricValue(summary, label) {
    var metrics = Array.isArray(summary && summary.metrics) ? summary.metrics : [];
    var metric = metrics.find(function (item) { return item && item.label === label; });
    if (!metric) return null;
    var value = Number(metric.value);
    return Number.isFinite(value) ? value : null;
  }

  function analyticsHistoryBuckets(summary) {
    var days = Array.isArray(summary && summary.daily) ? summary.daily : [];
    return days.map(function (point) {
      var label = String(point.local_day || '').slice(5) || String(point.local_day || '');
      return {
        start: point.local_day || '',
        label: label,
        event_count: Number(point.events || 0),
        failure_count: Number(point.failures || 0),
        active_sessions: Number(point.sessions || 0),
      };
    });
  }

  function analyticsHistoryModelMix(summary) {
    var rows = Array.isArray(summary && summary.model_mix) ? summary.model_mix.filter(function (item) {
      return Number(item && item.secondary_value || 0) > 0;
    }) : [];
    var total = rows.reduce(function (sum, item) { return sum + Number(item.secondary_value || 0); }, 0);
    return rows.map(function (item) {
      var count = Number(item.secondary_value || 0);
      return {
        name: item.label || 'Unknown',
        count: count,
        percent: total > 0 ? (count / total) * 100 : 0,
        last_seen: '',
      };
    });
  }

  function historyWithAnalyticsSummary(history, summary) {
    if (!history || !summary) return history;
    var sessions = analyticsMetricValue(summary, 'Sessions');
    var events = analyticsMetricValue(summary, 'Events');
    var turns = analyticsMetricValue(summary, 'Turns');
    var tools = analyticsMetricValue(summary, 'Tool calls');
    var failures = analyticsMetricValue(summary, 'Failures');
    var input = analyticsMetricValue(summary, 'Input tokens');
    var output = analyticsMetricValue(summary, 'Output tokens');
    return Object.assign({}, history, {
      generated_at_ms: summary.generated_at_ms || history.generated_at_ms,
      session_count: sessions != null ? sessions : history.session_count,
      event_count: events != null ? events : history.event_count,
      turn_count: turns != null ? turns : history.turn_count,
      tool_count: tools != null ? tools : history.tool_count,
      failure_count: failures != null ? failures : history.failure_count,
      input_tokens: input != null ? input : history.input_tokens,
      output_tokens: output != null ? output : history.output_tokens,
      activity_7d: summary.daily && summary.daily.length ? analyticsHistoryBuckets(summary) : history.activity_7d,
      model_mix: summary.model_mix && summary.model_mix.length ? analyticsHistoryModelMix(summary) : history.model_mix,
    });
  }

  function historySessionLabel(scope) {
    var label = String(scope && scope.label || '').trim();
    var id = shortSessionId(scope && scope.session_id);
    return label ? label + ' · ' + id : id;
  }

  function updateHistorySessionFilter(history) {
    if (!historySessionFilterSelect) return;
    var scopes = historySessionScopes(history);
    var valid = historySessionFilter === 'all' || scopes.some(function (scope) { return scope.session_id === historySessionFilter; });
    if (!valid) historySessionFilter = 'all';
    var options = '<option value="all">All sessions</option>' + scopes.map(function (scope) {
      var id = String(scope.session_id || '');
      return '<option value="' + escapeHtml(id) + '"' + (id === historySessionFilter ? ' selected' : '') + '>' + escapeHtml(historySessionLabel(scope)) + '</option>';
    }).join('');
    if (historySessionFilterSelect.innerHTML !== options) {
      historySessionFilterSelect.innerHTML = options;
    }
    historySessionFilterSelect.value = historySessionFilter;
    historySessionFilterSelect.disabled = scopes.length === 0;
  }

  function historyHasData(history) {
    if (!history) return false;
    var bucketEvents = (history.activity_24h || []).concat(history.activity_7d || []).some(function (bucket) {
      return Number(bucket.event_count || 0) > 0 || Number(bucket.failure_count || 0) > 0;
    });
    return bucketEvents
      || Number(history.event_count || 0) > 0
      || Number(history.tool_count || 0) > 0
      || (history.model_mix || []).length > 0
      || (history.category_mix || []).length > 0
      || (history.top_tools || []).length > 0
      || (history.recent_sessions || []).length > 0
      || (history.recent_failures || []).length > 0;
  }

  function generatedAtLabel(history) {
    var ms = Number(history && history.generated_at_ms || 0);
    if (!Number.isFinite(ms) || ms <= 0) return 'Waiting for activity scan...';
    var date = new Date(ms);
    if (Number.isNaN(date.getTime())) return 'Waiting for activity scan...';
    return 'Updated ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function historyAgeLabel(iso) {
    var age = ageFromIso(iso);
    return age ? age + ' ago' : 'unknown';
  }

  function shortSessionId(id) {
    var text = String(id || '');
    return text.length > 8 ? text.slice(0, 8) : text || 'unknown';
  }

  function cleanSessionLabel(value) {
    var text = String(value || '').trim();
    var normalized = text.toLowerCase();
    if (!text || normalized === 'unknown' || normalized === 'unknown repo' || normalized === 'unknown repository' || normalized === '|-') return '';
    return text;
  }

  function cssToken(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  }

  function historyCategoryFillClass(category) {
    var key = cssToken(category);
    return CATEGORY_COLORS[key] ? 'history-fill-category-' + key : 'history-bar-svg-fill';
  }

  function historyPaletteFillClass(index) {
    return 'history-fill-palette-' + (Math.max(0, index) % 8);
  }

  function historySvgPercent(percent) {
    var value = Number(percent || 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0.25, Math.min(100, value));
  }

  function historyLeftRoundedPath(width, height) {
    var fillWidth = Number(width || 0);
    var barHeight = Number(height || 10);
    if (!Number.isFinite(fillWidth) || fillWidth <= 0 || !Number.isFinite(barHeight) || barHeight <= 0) return '';
    var radiusY = barHeight / 2;
    var radiusX = Math.min(radiusY, fillWidth);
    var curve = 0.5522847498;
    return [
      'M', radiusX, 0,
      'H', fillWidth,
      'V', barHeight,
      'H', radiusX,
      'C', radiusX - radiusX * curve, barHeight, 0, radiusY + radiusY * curve, 0, radiusY,
      'C', 0, radiusY - radiusY * curve, radiusX - radiusX * curve, 0, radiusX, 0,
      'Z',
    ].join(' ');
  }

  function historyFillWidth(percent, totalWidth) {
    var pct = historySvgPercent(percent);
    var width = Number(totalWidth || 100);
    if (pct <= 0 || !Number.isFinite(width) || width <= 0) return 0;
    return Math.min(width, Math.max(1, (pct / 100) * width));
  }

  function historyBarPercent(value, max) {
    var count = Number(value || 0);
    var limit = Number(max || 0);
    if (!Number.isFinite(count) || !Number.isFinite(limit) || limit <= 0 || count <= 0) return 0;
    return Math.max(2, Math.min(100, Math.round((count / limit) * 100)));
  }

  function historyMetricBarPercent(metric, max) {
    var percent = Number(metric && metric.percent);
    if (Number.isFinite(percent) && percent >= 0) {
      return Math.max(0, Math.min(100, percent));
    }
    return historyBarPercent(metric && metric.count, max);
  }

  function renderHistoryBar(percent, fillClass) {
    var fillWidth = historyFillWidth(percent, 100);
    return '<div class="history-bar" aria-hidden="true">'
      + '<svg class="history-bar-svg history-bar-svg-horizontal" data-history-width="100" viewBox="0 0 100 10" preserveAspectRatio="none" focusable="false">'
      + '<path class="history-bar-svg-fill ' + escapeHtml(fillClass) + '" data-percent="' + historySvgPercent(percent) + '" d="' + historyLeftRoundedPath(fillWidth, 10) + '"></path>'
      + '</svg>'
      + '</div>';
  }

  function renderHistoryVerticalBar(percent, fillClass) {
    var height = Math.max(0, Math.min(100, Number(percent || 0)));
    var y = 100 - height;
    return '<div class="history-bar" aria-hidden="true">'
      + '<svg class="history-bar-svg history-bar-svg-vertical" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">'
      + '<rect class="history-bar-svg-fill ' + escapeHtml(fillClass) + '" x="0" y="' + y + '" width="100" height="' + height + '" rx="5"></rect>'
      + '</svg>'
      + '</div>';
  }

  function refreshHistoryBarShapes(root) {
    var scope = root || document;
    var svgs = scope.querySelectorAll('.history-bar-svg-horizontal');
    svgs.forEach(function (svg) {
      var rect = svg.getBoundingClientRect();
      var width = Math.round(rect.width || Number(svg.getAttribute('data-history-width')) || 100);
      var height = Number(svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.height) || 10;
      if (!Number.isFinite(width) || width <= 0) return;
      svg.setAttribute('data-history-width', String(width));
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.querySelectorAll('path[data-percent]').forEach(function (path) {
        var percent = Number(path.getAttribute('data-percent') || 0);
        path.setAttribute('d', historyLeftRoundedPath(historyFillWidth(percent, width), height));
      });
    });
  }

  function scheduleHistoryBarShapeRefresh() {
    if (historyBarRefreshFrame || !historyContent) return;
    historyBarRefreshFrame = window.requestAnimationFrame(function () {
      historyBarRefreshFrame = 0;
      if (appRoute === 'history') refreshHistoryBarShapes(historyContent);
    });
  }

  function historyMetricTotal(history, field, fallback) {
    var direct = Number(history && history[field]);
    if (Number.isFinite(direct)) return direct;
    if (field === 'event_count') {
      var sessionTotal = (history.recent_sessions || []).reduce(function (sum, session) {
        return sum + Number(session.event_count || 0);
      }, 0);
      if (sessionTotal > 0) return sessionTotal;
    }
    var fallbackTotal = Number(fallback);
    if (Number.isFinite(fallbackTotal)) return fallbackTotal;
    if (field === 'tool_count') {
      return (history.top_tools || []).reduce(function (sum, tool) { return sum + Number(tool.count || 0); }, 0);
    }
    return 0;
  }

  function historyUniqueModelCount(history) {
    var metrics = Array.isArray(history && history.model_mix) ? history.model_mix : [];
    var modelNames = metrics.map(function (metric) {
      return String(metric && metric.name || '').trim();
    }).filter(Boolean);
    return new Set(modelNames).size;
  }

  function historyKpis(view, history, scoped) {
    var activity = view && view.activity || {};
    var sessions = history.recent_sessions || [];
    var bucketEvents = (history.activity_24h || []).reduce(function (sum, bucket) { return sum + Number(bucket.event_count || 0); }, 0);
    var eventTotal = historyMetricTotal(history, 'event_count', scoped ? bucketEvents : activity.totalEvents);
    var toolTotal = historyMetricTotal(history, 'tool_count', scoped ? undefined : activity.totalToolCalls);
    var tokenTotals = tokenTotalsForHistory(view, history, scoped);
    var sessionTotal = historyMetricTotal(history, 'session_count', scoped ? sessions.length : activity.scannedSessions);
    var cards = [
      { label: scoped || !hasHistoryAnalyticsSummary(historyAnalyticsSummary) ? 'Sessions Scanned' : 'Sessions Indexed', value: sessionTotal },
      { label: 'Events', value: eventTotal },
      { label: 'Tool Calls', value: toolTotal },
      { label: 'Models Used', value: historyUniqueModelCount(history) },
      { label: 'Input Tokens', value: tokenTotals.inputPending ? 'pending' : tokenTotals.input, token: true },
      { label: 'Output Tokens', value: tokenTotals.output, token: true },
    ];
    return '<section class="history-kpis" aria-label="History summary metrics">'
      + cards.map(function (card) {
        var value = typeof card.value === 'number' ? exactNumber(card.value) : card.value;
        return '<article class="history-kpi' + (card.token ? ' history-token-kpi' : '') + '">'
          + '<div class="history-kpi-label' + (card.token ? ' history-token-label' : '') + '">' + escapeHtml(card.label) + '</div>'
          + '<div class="history-kpi-value' + (card.token ? ' history-token-value' : '') + '">' + escapeHtml(value) + '</div>'
          + (card.note ? '<div class="history-kpi-note">' + escapeHtml(card.note) + '</div>' : '')
          + '</article>';
      }).join('')
      + '</section>';
  }

  function tokenTotalsForHistory(view, history, scoped) {
    if (scoped) {
      var session = history && history.recent_sessions && history.recent_sessions[0];
      var input = Number(session && session.input_tokens || 0);
      var output = Number(session && session.output_tokens || 0);
      return {
        input: input,
        output: output,
        inputPending: input <= 0 && output > 0,
      };
    }
    var indexedInput = Number(history && history.input_tokens);
    var indexedOutput = Number(history && history.output_tokens);
    if (Number.isFinite(indexedInput) && Number.isFinite(indexedOutput)) {
      return {
        input: indexedInput,
        output: indexedOutput,
        inputPending: false,
      };
    }
    var activity = view && view.activity || {};
    return {
      input: Number(activity.totalInputTokens || 0),
      output: Number(activity.totalOutputTokens || 0),
      inputPending: false,
    };
  }

  function updateHistoryChartReadout(target, event) {
    if (!target || typeof target.closest !== 'function') return;
    var point = target.closest('[data-history-readout]');
    if (!point) return;
    var card = point.closest('.history-card');
    var readout = card && card.querySelector('.history-chart-readout');
    var text = point.getAttribute('data-history-readout') || '';
    if (!readout || !text) return;
    readout.textContent = text;
    readout.classList.add('visible');
    var clientX = event && Number.isFinite(event.clientX) ? event.clientX : 0;
    var clientY = event && Number.isFinite(event.clientY) ? event.clientY : 0;
    if (!clientX || !clientY) {
      var pointRect = point.getBoundingClientRect();
      clientX = pointRect.left + pointRect.width / 2;
      clientY = pointRect.top + pointRect.height / 2;
    }
    var cardRect = card.getBoundingClientRect();
    var readoutRect = readout.getBoundingClientRect();
    var x = Math.max(8, Math.min(cardRect.width - readoutRect.width - 24, clientX - cardRect.left));
    var y = Math.max(44, Math.min(cardRect.height - readoutRect.height - 24, clientY - cardRect.top));
    readout.style.setProperty('--readout-x', x + 'px');
    readout.style.setProperty('--readout-y', y + 'px');
  }

  function hideHistoryChartReadout(target) {
    if (!target || typeof target.closest !== 'function') return;
    var card = target.closest('.history-card');
    var readout = card && card.querySelector('.history-chart-readout');
    if (readout) readout.classList.remove('visible');
  }

  function historyHourAxisLabels(count, generatedAtMs) {
    var labels = new Map();
    if (count <= 0) return labels;
    var nowMs = Number(generatedAtMs || 0);
    [
      { age: 24, suffix: '24h ago' },
      { age: 18, suffix: '18h ago' },
      { age: 12, suffix: '12h ago' },
      { age: 6, suffix: '6h ago' },
      { age: 0, suffix: 'now' },
    ].forEach(function (tick) {
      var progress = (24 - tick.age) / 24;
      var index = Math.round(progress * (count - 1));
      var tickMs = nowMs > 0 ? nowMs - tick.age * 60 * 60 * 1000 : 0;
      labels.set(Math.max(0, Math.min(count - 1, index)), {
        primary: formatHistoryAxisTime(tickMs) || tick.suffix,
        secondary: tick.suffix,
      });
    });
    return labels;
  }

  function historyHourReadoutLabel(index, count, bucket) {
    var bucketClock = bucket && bucket.start ? formatHistoryAxisTime(Date.parse(bucket.start)) : '';
    if (count <= 1 || index === count - 1) return (bucketClock ? bucketClock + ' · ' : '') + 'Current hour';
    var progress = index / Math.max(1, count - 1);
    var age = Math.max(1, Math.round(24 - progress * 24));
    return (bucketClock ? bucketClock + ' · ' : '') + age + 'h ago';
  }

  function renderHistoryChart(title, copy, buckets, idPrefix, options) {
    var data = Array.isArray(buckets) ? buckets : [];
    if (!data.length || !data.some(function (bucket) { return Number(bucket.event_count || 0) > 0; })) {
      return '<article class="history-card" data-history-card="' + escapeHtml(idPrefix) + '">'
        + '<div class="history-card-title"><span>' + escapeHtml(title) + '</span><span>events</span></div>'
        + '<p class="history-card-copy">' + escapeHtml(copy) + '</p>'
        + '<div class="history-empty">No observed events in this time window.</div>'
        + '</article>';
    }

    var max = data.reduce(function (acc, bucket) {
      return Math.max(acc, Number(bucket.event_count || 0));
    }, 1);
    var width = 720;
    var height = 180;
    var left = 28;
    var top = 14;
    var bottom = 28;
    var plotW = width - left - 8;
    var plotH = height - top - bottom;
    var gap = data.length > 12 ? 3 : 7;
    var barW = Math.max(3, (plotW - gap * (data.length - 1)) / data.length);
    var useRelativeHours = idPrefix === 'history-24h';
    var hourAxisLabels = useRelativeHours ? historyHourAxisLabels(data.length, options && options.generatedAtMs) : null;
    var axisLabels = [];
    var bars = data.map(function (bucket, index) {
      var total = Number(bucket.event_count || 0);
      var x = left + index * (barW + gap);
      var totalH = Math.max(total > 0 ? 2 : 0, (total / max) * plotH);
      var y = top + plotH - totalH;
      var bucketLabel = useRelativeHours ? historyHourReadoutLabel(index, data.length, bucket) : bucket.label;
      var axisLabel = useRelativeHours ? hourAxisLabels.get(index) : bucket.label;
      var agentStarts = Number(bucket.launch_count || 0);
      var readout = bucketLabel + ': ' + exactNumber(total) + ' events, ' + exactNumber(Number(bucket.active_sessions || 0)) + ' sessions'
        + (useRelativeHours ? ', ' + countLabel(agentStarts, 'agent start', 'agent starts') : '');
      var readoutAttr = ' data-history-readout="' + escapeHtml(readout) + '" tabindex="0" aria-label="' + escapeHtml(readout) + '"';
      var markerX = x + barW / 2;
      if (axisLabel) {
        axisLabels.push({ label: axisLabel, left: (markerX / width) * 100 });
      }
      return '<g>'
        + '<rect class="activity-soft" x="' + x.toFixed(1) + '" y="' + top + '" width="' + barW.toFixed(1) + '" height="' + plotH + '" rx="3"' + readoutAttr + '></rect>'
        + '<rect class="activity" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + totalH.toFixed(1) + '" rx="3"' + readoutAttr + '></rect>'
        + '</g>';
    }).join('');
    var summary = data.reduce(function (acc, bucket) {
      acc.events += Number(bucket.event_count || 0);
      return acc;
    }, { events: 0 });
    var axisHtml = axisLabels.map(function (item) {
      var label = item.label && typeof item.label === 'object'
        ? '<strong>' + escapeHtml(item.label.primary) + '</strong><em>' + escapeHtml(item.label.secondary) + '</em>'
        : escapeHtml(item.label);
      return '<span style="left:' + item.left.toFixed(3) + '%">' + label + '</span>';
    }).join('');

    return '<article class="history-card" data-history-card="' + escapeHtml(idPrefix) + '">'
      + '<div class="history-card-title"><span>' + escapeHtml(title) + '</span><span>events</span></div>'
      + '<p class="history-card-copy">' + escapeHtml(copy) + '</p>'
      + '<div class="history-chart-frame">'
      + '<svg class="history-chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-labelledby="' + escapeHtml(idPrefix) + '-title ' + escapeHtml(idPrefix) + '-desc" preserveAspectRatio="none">'
      + '<title id="' + escapeHtml(idPrefix) + '-title">' + escapeHtml(title) + '</title>'
      + '<desc id="' + escapeHtml(idPrefix) + '-desc">' + escapeHtml(summary.events + ' events across observed buckets.') + '</desc>'
      + '<line class="axis" x1="' + left + '" y1="' + (top + plotH) + '" x2="' + (width - 8) + '" y2="' + (top + plotH) + '"></line>'
      + bars
      + '</svg>'
      + '<div class="history-chart-axis" aria-hidden="true">' + axisHtml + '</div>'
      + '</div>'
      + '<div class="history-legend"><span>Events</span></div>'
      + '<div class="history-chart-readout" aria-live="polite">Hover a bar for exact values.</div>'
      + '</article>';
  }

  function renderRankCard(title, copy, metrics, empty, options) {
    var rows = Array.isArray(metrics) ? metrics : [];
    var max = rows.reduce(function (acc, row) { return Math.max(acc, Number(row.count || 0)); }, 0);
    var listClass = options && options.listClass ? ' ' + options.listClass : '';
    var cardId = options && options.cardId ? options.cardId : cssToken(title);
    var titleMeta = options && options.titleMeta ? options.titleMeta : 'count';
    var body = rows.length && max > 0
      ? '<div class="history-rank-list' + escapeHtml(listClass) + '">' + rows.map(function (metric, index) {
          var name = metric.name || 'Unknown';
          var fillClass = options && options.categoryColors ? historyCategoryFillClass(name) : (options && options.paletteColors ? historyPaletteFillClass(index) : 'history-bar-svg-fill');
          var label = options && options.categoryLabels ? categoryLabel(name) : name;
          var pct = Number(metric.percent || 0);
          var countLabel = exactNumber(metric.count || 0) + (pct > 0 ? ' · ' + pct.toFixed(1).replace(/\.0$/, '') + '%' : '');
          return '<div class="history-rank-row">'
            + '<div class="history-rank-meta"><span class="history-rank-name" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span><span>' + escapeHtml(countLabel) + '</span></div>'
            + renderHistoryBar(historyMetricBarPercent(metric, max), fillClass)
            + '</div>';
        }).join('') + '</div>'
      : '<div class="history-empty">' + escapeHtml(empty) + '</div>';
    return '<article class="history-card" data-history-card="' + escapeHtml(cardId) + '">'
      + '<div class="history-card-title"><span>' + escapeHtml(title) + '</span><span>' + escapeHtml(titleMeta) + '</span></div>'
      + '<p class="history-card-copy">' + escapeHtml(copy) + '</p>'
      + body
      + '</article>';
  }

  function renderVerticalRankCard(title, copy, metrics, empty, options) {
    var rows = Array.isArray(metrics) ? metrics : [];
    var max = rows.reduce(function (acc, row) { return Math.max(acc, Number(row.count || 0)); }, 0);
    var cardId = options && options.cardId ? options.cardId : cssToken(title);
    var titleMeta = options && options.titleMeta ? options.titleMeta : 'count';
    var body = rows.length && max > 0
      ? '<div class="history-rank-list compact-ranks vertical-ranks">' + rows.map(function (metric, index) {
          var name = metric.name || 'Unknown';
          var fillClass = options && options.categoryColors ? historyCategoryFillClass(name) : (options && options.paletteColors ? historyPaletteFillClass(index) : 'history-bar-svg-fill');
          var label = options && options.categoryLabels ? categoryLabel(name) : name;
          var pct = Number(metric.percent || 0);
          var countLabel = exactNumber(metric.count || 0) + (pct > 0 ? ' · ' + pct.toFixed(1).replace(/\.0$/, '') + '%' : '');
          return '<div class="history-rank-row">'
            + '<div class="history-rank-meta"><span class="history-rank-name" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span><span>' + escapeHtml(countLabel) + '</span></div>'
            + renderHistoryVerticalBar(historyMetricBarPercent(metric, max), fillClass)
            + '</div>';
        }).join('') + '</div>'
      : '<div class="history-empty">' + escapeHtml(empty) + '</div>';
    return '<article class="history-card history-rank-chart-card" data-history-card="' + escapeHtml(cardId) + '">'
      + '<div class="history-card-title"><span>' + escapeHtml(title) + '</span><span>' + escapeHtml(titleMeta) + '</span></div>'
      + '<p class="history-card-copy">' + escapeHtml(copy) + '</p>'
      + body
      + '</article>';
  }

  function renderActivityBreakdown(history) {
    return renderVerticalRankCard(
      'Activity Breakdown',
      'Distribution by Mission Control category across observed events.',
      history.category_mix,
      'No categorized events are visible yet.',
      { categoryColors: true, categoryLabels: true, cardId: 'event-mix' },
    );
  }

  function renderTopToolsCompact(history) {
    return renderRankCard(
      'Top Tools',
      'Most-used allowlisted tool names, capped by the backend.',
      history.top_tools,
      'No tool usage is visible yet.',
      { paletteColors: true, cardId: 'top-tools', listClass: 'compact-ranks' },
    ).replace('class="history-card"', 'class="history-card compact-card"');
  }

  function historySessionTokenPair(session) {
    var input = Number(session && session.input_tokens || 0);
    var output = Number(session && session.output_tokens || 0);
    var inputLabel = input <= 0 && output > 0 ? 'pending input tokens' : exactNumber(input) + ' input tokens';
    return inputLabel + ' · ' + exactNumber(output) + ' output tokens';
  }

  function highActivitySessions(history) {
    var rows = Array.isArray(history && history.high_activity_sessions) && history.high_activity_sessions.length
      ? history.high_activity_sessions
      : ((history && history.recent_sessions) || []);
    return rows.slice().sort(function (a, b) {
      return Number(b.turn_count || 0) - Number(a.turn_count || 0)
        || Number(b.tool_count || 0) - Number(a.tool_count || 0)
        || Number(b.event_count || 0) - Number(a.event_count || 0)
        || Number(b.output_tokens || 0) - Number(a.output_tokens || 0)
        || String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    }).slice(0, 8);
  }

  function renderHighActivitySessions(history) {
    var rows = highActivitySessions(history);
    if (!rows.length) {
      return '<article class="history-card" data-history-card="high-activity-sessions">'
        + '<div class="history-card-title"><span>High Activity Sessions</span><span>sessions</span></div>'
        + '<p class="history-card-copy">Ranks sessions by turns, tool calls, events, output tokens, then recency.</p>'
        + '<div class="history-empty">No high-activity sessions are visible yet.</div>'
        + '</article>';
    }
    var body = '<div class="history-activity-session-list">' + rows.map(function (session) {
      var title = session.title || session.session_name || session.repository || shortSessionId(session.id);
      var scope = [session.repository, session.branch].filter(Boolean).join(' / ');
      var details = (scope || shortSessionId(session.id))
        + ' · ' + countLabel(session.event_count, 'event', 'events')
        + ' · ' + countLabel(session.turn_count, 'turn', 'turns')
        + ' · ' + countLabel(session.tool_count, 'tool call', 'tool calls')
        + ' · ' + historySessionTokenPair(session)
        + ' · ' + countLabel(session.error_count, 'failure', 'failures');
      return '<div class="flight-log-row history-activity-session-row">'
        + '<strong>' + escapeHtml(title) + '</strong>'
        + '<span>' + escapeHtml(details) + '</span>'
        + '</div>';
    }).join('') + '</div>';
    return '<article class="history-card" data-history-card="high-activity-sessions">'
      + '<div class="history-card-title"><span>High Activity Sessions</span><span>sessions</span></div>'
      + '<p class="history-card-copy">Ranks sessions in this History range by turns, tool calls, events, output tokens, then recency.</p>'
      + body
      + '</article>';
  }

  function renderModelsCompact(metrics) {
    return renderRankCard(
      'Models Used',
      'Turn-level models are counted when available; sessions fall back to the last observed model, including Unknown.',
      metrics,
      'No model-bearing activity is visible yet.',
      { paletteColors: true, cardId: 'models-used', listClass: 'compact-ranks' },
    ).replace('class="history-card"', 'class="history-card compact-card"');
  }

  function renderHistorySessions(sessions) {
    var rows = Array.isArray(sessions) ? sessions : [];
    var body = rows.length
      ? '<div class="history-session-list">' + rows.map(function (session) {
          var title = session.title || session.session_name || session.repository || shortSessionId(session.id);
          var subtitleParts = [
            session.branch ? 'branch ' + session.branch : '',
            session.last_model ? 'model ' + session.last_model : 'model unknown',
            session.last_tool ? 'tool ' + session.last_tool : '',
          ].filter(Boolean);
          var statusClass = cssToken(session.status || (session.is_active ? 'working' : 'idle'));
          var stats = [
            exactNumber(session.event_count || 0) + ' events',
          ];
          return '<div class="history-session-row">'
            + '<span class="history-dossier-id">' + escapeHtml(shortSessionId(session.id)) + '</span>'
            + '<div class="history-session-main"><div class="history-row-title" title="' + escapeHtml(title) + '">' + escapeHtml(title) + '</div>'
            + '<div class="history-row-sub">' + escapeHtml(subtitleParts.join(' · ')) + '</div></div>'
            + '<span class="history-status ' + escapeHtml(statusClass) + '">' + escapeHtml(session.status || (session.is_active ? 'active' : 'idle')) + '</span>'
            + '<div class="history-row-meta history-session-age">' + escapeHtml(historyAgeLabel(session.updated_at)) + ' <span aria-hidden="true">·</span> <span class="history-session-stats">' + escapeHtml(stats.join(' · ')) + '</span></div>'
            + '</div>';
        }).join('') + '</div>'
      : '<div class="history-empty">No scanned sessions are available yet.</div>';
    return '<article class="history-card" data-history-card="recent-sessions">'
      + '<div class="history-card-title"><span>Recent Sessions</span><span>status</span></div>'
      + '<p class="history-card-copy">Latest privacy-safe session summaries across the scanned activity window.</p>'
      + body
      + '</article>';
  }

  function historyLoadingMarkup() {
    return '<div class="history-loading-stage" role="status" aria-live="polite">'
      + '<div class="history-loading-dialog">'
      + '<div class="history-loading-title">Scanning Copilot CLI history</div>'
      + '<div class="history-loading-copy">Building local session, event, tool, model, and token summaries.</div>'
      + '<div class="history-loading-bar" aria-hidden="true"><span></span></div>'
      + '</div>'
      + '</div>';
  }

  function flightLogLoadingMarkup() {
    return '<div class="history-loading-stage" role="status" aria-live="polite">'
      + '<div class="history-loading-dialog">'
      + '<div class="history-loading-title">Preparing Daily Log</div>'
      + '<div class="history-loading-copy">Building the calendar and Daily Debrief from local analytics.</div>'
      + '<div class="history-loading-bar" aria-hidden="true"><span></span></div>'
      + '</div>'
      + '</div>';
  }

  function renderHistoryTabs() {
    var isFlightLog = historyTab === 'flight-log';
    if (historyOverviewTab) {
      historyOverviewTab.classList.toggle('active', !isFlightLog);
      historyOverviewTab.setAttribute('aria-selected', isFlightLog ? 'false' : 'true');
      if (!isFlightLog) historyOverviewTab.setAttribute('aria-current', 'page');
      else historyOverviewTab.removeAttribute('aria-current');
    }
    if (historyFlightLogTab) {
      historyFlightLogTab.classList.toggle('active', isFlightLog);
      historyFlightLogTab.setAttribute('aria-selected', isFlightLog ? 'true' : 'false');
      if (isFlightLog) historyFlightLogTab.setAttribute('aria-current', 'page');
      else historyFlightLogTab.removeAttribute('aria-current');
    }
    if (historyOverviewPanel) historyOverviewPanel.hidden = isFlightLog;
    if (historyFlightLogPanel) historyFlightLogPanel.hidden = !isFlightLog;
    var filter = historySessionFilterSelect && historySessionFilterSelect.closest('.history-filter');
    if (filter) filter.hidden = isFlightLog;
    if (historySessionFilterSelect) {
      historySessionFilterSelect.hidden = isFlightLog;
      historySessionFilterSelect.disabled = isFlightLog;
    }
    if (historyKpiSummary) historyKpiSummary.hidden = isFlightLog;
  }

  function metricByLabel(metrics, label) {
    var row = (metrics || []).find(function (metric) { return metric.label === label; });
    return row ? Number(row.value || 0) : 0;
  }

  function renderFlightLogSummary(day) {
    var metrics = day.totals || [];
    var cards = [
      ['Sessions', metricByLabel(metrics, 'Sessions')],
      ['Turns', metricByLabel(metrics, 'Turns')],
      ['Input tokens', metricByLabel(metrics, 'Input tokens')],
      ['Output tokens', metricByLabel(metrics, 'Output tokens')],
    ];
    return '<div class="flight-log-summary" aria-label="Daily Debrief summary">'
      + cards.map(function (card) {
        return '<div class="flight-log-stat"><div class="flight-log-stat-label">' + escapeHtml(card[0]) + '</div>'
          + '<div class="flight-log-stat-value">' + escapeHtml(exactNumber(card[1])) + '</div></div>';
      }).join('')
      + '</div>';
  }

  function flightLogMonthOptions(selectedMonth) {
    var labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var selected = Number(String(selectedMonth || '').slice(5, 7)) || 1;
    return labels.map(function (label, index) {
      var value = String(index + 1).padStart(2, '0');
      return '<option value="' + value + '"' + (index + 1 === selected ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
  }

  function flightLogYearOptions(selectedMonth, availableYears) {
    var todayYear = new Date().getFullYear();
    var selectedYear = Number(String(selectedMonth || '').slice(0, 4)) || todayYear;
    var years = (availableYears || []).map(function (year) { return Number(year); })
      .filter(function (year) { return Number.isFinite(year); });
    if (years.indexOf(selectedYear) < 0) years.push(selectedYear);
    years = Array.from(new Set(years)).sort(function (a, b) { return b - a; });
    return years.map(function (year) {
      return '<option value="' + year + '"' + (year === selectedYear ? ' selected' : '') + '>' + year + '</option>';
    }).join('');
  }

  function renderFlightLogYearControl(selectedMonth, availableYears) {
    var years = (availableYears || []).map(function (year) { return Number(year); })
      .filter(function (year) { return Number.isFinite(year); });
    years = Array.from(new Set(years));
    var selectedYear = Number(String(selectedMonth || '').slice(0, 4)) || new Date().getFullYear();
    if (years.length <= 1) {
      return '<span class="flight-log-control flight-log-year-label" data-flight-log-year-label data-year="' + escapeHtml(selectedYear) + '">' + escapeHtml(selectedYear) + '</span>';
    }
    return '<select class="flight-log-control flight-log-select year" data-flight-log-year-select aria-label="Jump to year">' + flightLogYearOptions(selectedMonth, years) + '</select>';
  }

  function renderFlightLogCalendar(digest) {
    var days = digest.calendar_days || [];
    var weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var selectedMonth = digest.month || flightLogMonth;
    var isCurrentMonth = selectedMonth >= localDayString(new Date()).slice(0, 7);
    return '<article class="history-card flight-log-calendar-card" data-history-card="flight-log-calendar">'
      + '<div class="history-card-title"><span>Calendar</span><span>activity</span></div>'
      + '<div class="flight-log-toolbar">'
      + '<div class="flight-log-jump">'
      + '<select class="flight-log-control flight-log-select month" data-flight-log-month-select aria-label="Jump to month">' + flightLogMonthOptions(selectedMonth) + '</select>'
      + renderFlightLogYearControl(selectedMonth, digest.available_years)
      + '</div>'
      + '<div class="flight-log-nav">'
      + '<button class="flight-log-control flight-log-button" type="button" data-flight-log-month="-1" aria-label="Previous month">Prev</button>'
      + '<button class="flight-log-control flight-log-button" type="button" data-flight-log-month="1" aria-label="Next month"' + (isCurrentMonth ? ' disabled aria-disabled="true"' : '') + '>Next</button>'
      + '<button class="flight-log-control flight-log-button" type="button" data-flight-log-today>Today</button>'
      + '</div></div>'
      + '<div class="flight-log-weekdays" aria-hidden="true">' + weekdays.map(function (day) { return '<span>' + day + '</span>'; }).join('') + '</div>'
      + '<div class="flight-log-calendar" role="grid" aria-label="Daily Log activity calendar">'
      + days.map(function (day) {
        var selected = day.local_day === digest.selected_day;
        var classes = ['flight-log-day'];
        var enabled = day.enabled !== false && Number(day.events || 0) > 0;
        if (!day.in_month) classes.push('outside');
        if (enabled) classes.push('has-events');
        else classes.push('disabled');
        if (selected) classes.push('selected');
        if (day.is_today) classes.push('today');
        var labelParts = [day.local_day];
        if (Number(day.events || 0) > 0) labelParts.push(exactNumber(day.events || 0) + ' events', exactNumber(day.sessions || 0) + ' sessions');
        else labelParts.push('No indexed activity');
        if (day.failures) labelParts.push(exactNumber(day.failures) + ' failures');
        return '<button class="' + classes.join(' ') + '" type="button" role="gridcell" data-flight-log-day="' + escapeHtml(day.local_day) + '" aria-label="' + escapeHtml(labelParts.join(', ')) + '" aria-selected="' + (selected ? 'true' : 'false') + '"' + (!enabled ? ' disabled aria-disabled="true"' : '') + '>'
          + '<div class="flight-log-day-number">' + escapeHtml(day.day_number) + '</div>'
          + '</button>';
      }).join('')
      + '</div></article>';
  }

  function renderFlightLogRows(rows, empty, mapper) {
    if (!rows || !rows.length) return '<div class="history-empty">' + escapeHtml(empty) + '</div>';
    return rows.map(mapper).join('');
  }

  function flightLogTokenPair(item) {
    var input = Number(item && item.input_tokens || 0);
    var output = Number(item && item.output_tokens || 0);
    var inputLabel = input <= 0 && output > 0 ? 'pending' : exactNumber(input);
    return inputLabel + ' input tokens · ' + exactNumber(output) + ' output tokens';
  }

  function countLabel(count, singular, plural) {
    var value = Number(count || 0);
    return exactNumber(value) + ' ' + (value === 1 ? singular : plural);
  }

  function flightLogExportTitle(item) {
    if (!item) return 'Export';
    if (item.kind === 'daily-digest') return 'Daily Digest';
    return String(item.label || 'Export').replace(/^Copy\s+/i, '');
  }

  function flightLogExportRows(body) {
    var lines = String(body || '').split('\n').length;
    return Math.max(4, Math.min(7, lines));
  }

  function renderFlightLogExports(exports) {
    if (!exports || !exports.length) return '';
    return '<div class="flight-log-export-list">'
      + exports.map(function (item) {
        var title = flightLogExportTitle(item);
        var expanded = !!flightLogExpandedExports[item.kind];
        return '<details class="flight-log-export-panel"' + (expanded ? ' open' : '') + ' data-flight-log-export-panel="' + escapeHtml(item.kind) + '">'
          + '<summary>' + escapeHtml(title) + '</summary>'
          + '<div class="flight-log-export-preview">'
          + '<textarea readonly rows="' + flightLogExportRows(item.body) + '" aria-label="' + escapeHtml(title + ' preview') + '">' + escapeHtml(item.body || '') + '</textarea>'
          + '<button class="flight-log-control flight-log-export" type="button" data-flight-log-export="' + escapeHtml(item.kind) + '" aria-label="Copy ' + escapeHtml(title) + '" title="Copy ' + escapeHtml(title) + '">⧉</button>'
          + '</div></details>';
      }).join('')
      + '</div>';
  }

  function renderFlightLogActivityRate(buckets) {
    var rows = Array.isArray(buckets) ? buckets : [];
    if (!rows.length || !rows.some(function (bucket) { return Number(bucket.event_count || 0) > 0; })) {
      return '<section class="flight-log-section flight-log-activity-rate"><h3>Activity Rate</h3><div class="history-empty">No hourly activity is indexed for this day.</div></section>';
    }
    var peak = rows.reduce(function (max, bucket) { return Math.max(max, Number(bucket.event_count || 0)); }, 0);
    var activeHours = rows.filter(function (bucket) { return Number(bucket.event_count || 0) > 0; }).length;
    var busiest = rows.reduce(function (best, bucket) {
      if (!best || Number(bucket.event_count || 0) >= Number(best.event_count || 0)) return bucket;
      return best;
    }, null);
    var totalEvents = rows.reduce(function (sum, bucket) { return sum + Number(bucket.event_count || 0); }, 0);
    var totalToolCalls = rows.reduce(function (sum, bucket) { return sum + Number(bucket.tool_call_count || 0); }, 0);
    var totalTurns = rows.reduce(function (sum, bucket) { return sum + Number(bucket.turn_count || 0); }, 0);
    var cells = rows.map(function (bucket, index) {
      var level = tempoIntensityLevel(bucket && bucket.intensity);
      var label = bucket && bucket.start_ms ? tempoBucketLocalRange({ start: new Date(Number(bucket.start_ms || 0)).toISOString() }) : (bucket && bucket.label || ('Hour ' + (index + 1)));
      var readout = label + ': '
        + countLabel(bucket.event_count, 'activity item', 'activity items') + ', '
        + countLabel(bucket.tool_call_count, 'tool call', 'tool calls') + ', '
        + countLabel(bucket.turn_count, 'turn', 'turns')
        + (Number(bucket.failure_count || 0) > 0 ? ', ' + countLabel(bucket.failure_count, 'failure', 'failures') : '');
      return '<span class="flight-log-activity-cell" data-intensity="' + level + '" data-history-readout="' + escapeHtml(readout) + '" tabindex="0" aria-label="' + escapeHtml(readout) + '"></span>';
    }).join('');
    return '<section class="flight-log-section flight-log-activity-rate"><h3>Activity Rate</h3>'
      + '<p class="flight-log-section-copy">Hourly activity across all sessions for this day.</p>'
      + '<div class="flight-log-activity-strip" aria-label="Daily activity rate by hour">' + cells + '</div>'
      + '<div class="history-chart-readout" aria-live="polite">Hover an hour for tool calls, turns, and failures.</div>'
      + '<div class="flight-log-activity-stats">'
      + '<div><span>Peak hour</span><strong>' + escapeHtml(countLabel(peak, 'activity item', 'activity items')) + '</strong></div>'
      + '<div><span>Busiest</span><strong>' + escapeHtml(busiest && busiest.event_count > 0 ? busiest.label || 'Active' : 'No activity') + '</strong></div>'
      + '<div><span>Active hours</span><strong>' + escapeHtml(exactNumber(activeHours) + '/24') + '</strong></div>'
      + '<div><span>Day total</span><strong>' + escapeHtml(exactNumber(totalEvents) + ' events · ' + exactNumber(totalToolCalls) + ' tools · ' + exactNumber(totalTurns) + ' turns') + '</strong></div>'
      + '</div></section>';
  }

  function renderFlightLogDebrief(digest) {
    var day = digest.day || defaultEngineeringDigest({ selected_day: digest.selected_day, month: digest.month }).day;
    var exports = day.exports || [];
    var debriefDate = day.local_day || digest.selected_day;
    return '<article class="history-card flight-log-debrief" data-history-card="flight-log-debrief">'
      + '<div class="history-card-title"><span>Daily Debrief - ' + escapeHtml(localDateLabel(debriefDate)) + '</span><span>selected day</span></div>'
      + renderFlightLogSummary(day)
      + '<section class="flight-log-section flight-log-narrative"><h3>Mission Summary</h3>' + escapeHtml(day.narrative || '') + '</section>'
      + renderFlightLogActivityRate(day.activity_rate)
      + '<div class="flight-log-debrief-grid">'
      + '<section class="flight-log-section"><h3>What I Worked On</h3>'
      + renderFlightLogRows(day.repos, 'No project activity is indexed for this day.', function (repo) {
        return '<div class="flight-log-row"><strong>' + escapeHtml(repo.repository + ' / ' + repo.branch) + '</strong>'
          + '<span>' + escapeHtml(exactNumber(repo.events || 0) + ' events · ' + exactNumber((repo.sessions || []).length) + ' sessions · ' + exactNumber(repo.output_tokens || 0) + ' output tokens') + '</span>'
          + (repo.sessions || []).slice(0, 3).map(function (session) { return '<span>' + escapeHtml(session.title || session.session_hash) + '</span>'; }).join('')
          + '</div>';
      })
      + '<div class="flight-log-export-instruction">Expand a section to preview it before copying.</div>'
      + renderFlightLogExports(exports)
      + '<div class="flight-log-copy-status" aria-live="polite">' + escapeHtml(flightLogCopyStatus) + '</div></section>'
      + '<section class="flight-log-section"><h3>Models</h3>'
      + renderFlightLogRows(day.models, 'No model activity is indexed for this day.', function (model) {
        return '<div class="flight-log-row"><strong>' + escapeHtml(model.label || 'Unknown') + '</strong><span>' + escapeHtml(exactNumber(model.secondary_value || 0) + ' turns · ' + exactNumber(model.value || 0) + ' output tokens') + '</span></div>';
      }) + '</section>'
      + '<section class="flight-log-section"><h3>Token Hotspots</h3>'
      + renderFlightLogRows(day.token_hotspots, '', function (session) {
        return '<div class="flight-log-row"><strong>' + escapeHtml(session.title || session.session_hash) + '</strong><span>' + escapeHtml(flightLogTokenPair(session) + ' · ' + (session.last_model || 'Unknown')) + '</span></div>';
      }) + '</section>'
      + '<section class="flight-log-section"><h3>Tools / MCP</h3>'
      + renderFlightLogRows(day.tools, 'No tool activity is indexed for this day.', function (tool) {
        return '<div class="flight-log-row"><strong>' + escapeHtml(tool.name || 'tool') + '</strong><span>' + escapeHtml(categoryLabel(tool.category || 'activity') + ' · ' + countLabel(tool.calls, 'call', 'calls') + ' · ' + countLabel(tool.failures, 'failure', 'failures') + (tool.total_duration_ms ? ' · ' + formatDuration(tool.total_duration_ms) : '')) + '</span></div>';
      }) + '</section>'
      + '<section class="flight-log-section"><h3>High Activity Sessions</h3>'
      + renderFlightLogRows(day.useful_sessions, 'No high-signal sessions are indexed for this day.', function (session) {
        return '<div class="flight-log-row"><strong>' + escapeHtml(session.title || session.session_hash) + '</strong><span>' + escapeHtml(session.repository + ' / ' + session.branch + ' · ' + countLabel(session.events, 'event', 'events') + ' · ' + countLabel(session.turns, 'turn', 'turns') + ' · ' + countLabel(session.tool_calls, 'tool call', 'tool calls') + ' · ' + flightLogTokenPair(session) + ' · ' + countLabel(session.failures, 'failure', 'failures')) + '</span></div>';
      }) + '</section>'
      + '</div></article>';
  }

  function renderFlightLog(force) {
    if (!historyFlightLogContent) return;
    if (flightLogLoading) {
      historyFlightLogContent.innerHTML = flightLogLoadingMarkup();
      return;
    }
    var digest = flightLogDigest || defaultEngineeringDigest({ selected_day: flightLogSelectedDay, month: flightLogMonth });
    if (flightLogError) {
      historyFlightLogContent.innerHTML = '<div class="history-empty">Daily Log could not load: ' + escapeHtml(flightLogError) + '</div>';
      return;
    }
    historyFlightLogContent.innerHTML = '<section class="flight-log" aria-label="Daily Log calendar">'
      + renderFlightLogCalendar(digest)
      + renderFlightLogDebrief(digest)
      + '</section>'
      + (digest.caveats && digest.caveats.length ? '<div class="history-empty">' + escapeHtml(digest.caveats.join(' ')) + '</div>' : '');
  }

  function copyFlightLogExport(kind) {
    var exports = flightLogDigest && flightLogDigest.day && flightLogDigest.day.exports || [];
    var item = exports.find(function (entry) { return entry.kind === kind; });
    if (!item) {
      flightLogCopyStatus = 'Nothing to copy for this export.';
      renderFlightLog(true);
      return;
    }
    flightLogExpandedExports[item.kind] = true;
    var done = function () {
      flightLogCopyStatus = flightLogExportTitle(item) + ' copied';
      renderFlightLog(true);
    };
    var fail = function (err) {
      flightLogCopyStatus = 'Copy failed: ' + (err && err.message ? err.message : String(err || 'clipboard unavailable'));
      renderFlightLog(true);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(item.body).then(done).catch(fail);
      return;
    }
    fail('clipboard unavailable');
  }

  function renderHistory(view, force) {
    if (!historyContent) return;
    renderHistoryTabs();
    if (historyTab === 'flight-log') {
      var flightFingerprint = historyFingerprint(view) + '|flight-log|' + flightLogFingerprint();
      if (!force && flightFingerprint === liveFingerprints.history) return;
      liveFingerprints.history = flightFingerprint;
      if (historySubtitle) historySubtitle.textContent = 'Review each day of Copilot activity with a calendar view and daily summary.';
      if (historyLiveStamp) historyLiveStamp.textContent = flightLogDigest && flightLogDigest.generated_at_ms ? generatedAtLabel({ generated_at_ms: flightLogDigest.generated_at_ms }) : 'Preparing Daily Log...';
      if (!flightLogDigest || flightLogDigest.selected_day !== flightLogSelectedDay || flightLogDigest.month !== flightLogMonth) {
        loadFlightLogDigest(false);
      }
      renderFlightLog(true);
      return;
    }
    if (!dashboardHasLoadedHistory(view) && cachedHistoryIsFresh()) {
      view = cachedHistoryDashboard;
    }
    var fingerprint = historyFingerprint(view) + '|overview';
    if (!force && fingerprint === liveFingerprints.history) return;
    liveFingerprints.history = fingerprint;

    if (!view) {
      if (historySubtitle) historySubtitle.textContent = defaultHistorySubtitle();
      if (historyLiveStamp) historyLiveStamp.textContent = 'Waiting for activity scan...';
      if (historyKpiSummary) historyKpiSummary.innerHTML = '';
      historyContent.innerHTML = historyLoadingMarkup();
      return;
    }

    var history = view.history;
    if (!history) {
      if (historySubtitle) historySubtitle.textContent = defaultHistorySubtitle();
      if (historyLiveStamp) historyLiveStamp.textContent = 'History unavailable in this scan';
      if (historyKpiSummary) historyKpiSummary.innerHTML = '';
      historyContent.innerHTML = '<div class="history-empty">History data is not available from the current activity scan yet. Mission Control will update this route when the backend provides aggregate history.</div>';
      updateHistorySessionFilter(null);
      return;
    }
    if (Number(history.generated_at_ms || 0) <= 0) {
      if (historySubtitle) historySubtitle.textContent = defaultHistorySubtitle();
      if (historyLiveStamp) historyLiveStamp.textContent = 'Loading full history scan...';
      if (historyKpiSummary) historyKpiSummary.innerHTML = '';
      historyContent.innerHTML = historyLoadingMarkup();
      updateHistorySessionFilter(null);
      return;
    }
    rememberHistoryDashboard(view);
    if (historySessionFilter === 'all') loadHistoryAnalyticsSummary(false);

    updateHistorySessionFilter(history);
    var scoped = historySessionFilter !== 'all';
    history = selectedHistorySummary(history);
    if (!scoped && hasHistoryAnalyticsSummary(historyAnalyticsSummary)) {
      history = historyWithAnalyticsSummary(history, historyAnalyticsSummary);
    }
    if (historySubtitle) historySubtitle.textContent = historySubtitleLabel(view, history, scoped);
    if (historyLiveStamp) historyLiveStamp.textContent = generatedAtLabel(history);
    if (historyKpiSummary) historyKpiSummary.innerHTML = historyKpis(view, history, scoped);
    if (!historyHasData(history)) {
      historyContent.innerHTML = '<div class="history-empty">No observed Copilot events are available yet. Start or continue a Copilot CLI session and this history view will populate from privacy-safe scan summaries.</div>';
      return;
    }

    historyContent.innerHTML = '<section class="history-grid" aria-label="History analytics">'
      + '<div class="history-column history-tools-region">'
      + renderModelsCompact(history.model_mix)
      + renderTopToolsCompact(history)
      + '</div>'
      + '<div class="history-column history-chart-region">'
      + renderHistoryChart('Activity, Rolling 24 Hours', 'Hourly buckets across the last 24 hours in your local time zone; right edge is now.', history.activity_24h, 'history-24h', { generatedAtMs: history.generated_at_ms })
      + renderHistoryChart('Activity, Last 7 Days', 'Daily activity over the last 7 days', history.activity_7d, 'history-7d')
      + '</div>'
      + '<div class="history-column history-breakdown-region">'
      + renderActivityBreakdown(history)
      + renderHighActivitySessions(history)
      + '</div>'
      + '<div class="history-column history-column-middle history-sessions-region">'
      + renderHistorySessions(history.recent_sessions)
      + '</div>'
      + '</section>';
    refreshHistoryBarShapes(historyContent);
    scheduleHistoryBarShapeRefresh();
  }

  window.__cmcRenderDashboard = function (view) {
    lastDashboard = view;
    markDashboardReady(view);
    if (appRoute === 'history') {
      renderHistory(view);
      updateLiveFingerprints(view);
      if (attentionOverlay && attentionOverlay.classList.contains('visible')) renderAttentionDialog(view.attention);
      maybeShowSchemaDrift(view);
      return;
    }
    var l = view.layout || {};
    var hideSides = !!view.panelsHidden;
    var columnGap = l.compact ? 10 : 12;
    var replayTop = Number.isFinite(l.replayY) && l.replayH > 0 ? l.replayY : l.bottomY;
    var columnBottom = Math.max(l.topY || 0, replayTop - columnGap);
    var columnH = Math.max(0, columnBottom - (l.topY || 0));
    var feedTargetH = recentFeedPanelHeight(view);
    var maxSessionH = Math.max(l.compact ? 160 : 180, columnH - feedTargetH - columnGap);
    if (domSession) {
      domSession.classList.remove('hidden', 'constrained');
    }
    setPanelRect(domSession, { x: l.leftX, y: l.topY, w: l.panelW });
    renderSession(view);
    var naturalSessionH = naturalPanelHeight(domSession, l.compact ? 140 : 160);
    var sessionExtraH = 0;
    var sessionMainH = Math.max(0, Math.min(naturalSessionH + sessionExtraH, maxSessionH));
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
    if (appRoute === 'history') renderHistory(view);
    if (attentionOverlay && attentionOverlay.classList.contains('visible')) renderAttentionDialog(view.attention);
    maybeShowSchemaDrift(view);
  };

  window.__cmcRenderLiveDashboard = function (view) {
    lastDashboard = view;
    markDashboardReady(view);
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
    if (appRoute === 'history') renderHistory(view);
    if (attentionOverlay && attentionOverlay.classList.contains('visible')) renderAttentionDialog(view.attention);
  };

  window.__cmcRenderQuarter = function (quarter) {
    if (lastDashboard) lastDashboard.quarter = quarter;
    renderQuarterData(quarter);
    liveFingerprints.quarter = quarterFingerprint({ quarter: quarter });
  };

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var attentionAction = target.closest('[data-attention-action]');
    if (attentionAction) {
      runAttentionAction(attentionItemById(attentionAction.getAttribute('data-attention-id') || ''));
      return;
    }
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
    if (name === 'attention-center') openAttentionCenter(action);
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

  document.addEventListener('pointerover', function (event) {
    updateTempoReadout(event.target);
  });
  document.addEventListener('pointermove', function (event) {
    updateTempoReadout(event.target);
  });
  document.addEventListener('focusin', function (event) {
    updateTempoReadout(event.target);
  });
  document.addEventListener('pointerout', function (event) {
    if (event.target && event.target.closest && event.target.closest('[data-tempo-readout]')) hideTempoReadout(event.target);
  });
  document.addEventListener('focusout', function (event) {
    hideTempoReadout(event.target);
  });

  [schemaDriftClose, schemaDriftDismiss].forEach(function (button) {
    if (!button) return;
    button.addEventListener('click', function () {
      if (activeSchemaDriftReport) {
        try {
          safeSet(STORAGE_KEYS.schemaDriftDismissed, schemaDriftFingerprint(activeSchemaDriftReport));
        } catch (_err) {
          // Ignore storage failures; the dialog can appear again on refresh.
        }
      }
      closeSchemaDriftDialog();
    });
  });

  if (attentionClose) attentionClose.addEventListener('click', closeAttentionCenter);
  if (attentionOverlay) {
    attentionOverlay.addEventListener('click', function (event) {
      if (event.target === attentionOverlay) closeAttentionCenter();
    });
  }

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

  if (missionRouteBtn) {
    missionRouteBtn.addEventListener('click', function () {
      navigateAppRoute('mission', true);
    });
  }
  if (historyRouteBtn) {
    historyRouteBtn.addEventListener('click', function () {
      navigateAppRoute('history', true);
    });
  }
  if (analyticsRouteBtn) {
    analyticsRouteBtn.addEventListener('click', function () {
      navigateAppRoute('analytics', true);
    });
  }
  if (analyticsChatForm) {
    analyticsChatForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var prompt = analyticsChatInput ? analyticsChatInput.value : '';
      askAnalytics(prompt);
    });
  }
  if (analyticsTokenAck) analyticsTokenAck.addEventListener('click', closeAnalyticsTokenNotice);
  if (analyticsTokenHelp) {
    analyticsTokenHelp.addEventListener('click', function () {
      showAnalyticsTokenNotice(analyticsTokenHelp);
    });
  }
  if (analyticsTokenNotice) {
    analyticsTokenNotice.addEventListener('click', function (event) {
      if (event.target === analyticsTokenNotice) closeAnalyticsTokenNotice();
    });
  }
  if (analyticsChatNew) {
    analyticsChatNew.addEventListener('click', function () {
      analyticsChatRequestSeq += 1;
      analyticsChatLoading = false;
      analyticsChatMessages = [];
      if (analyticsChatInput) analyticsChatInput.value = '';
      renderAnalyticsChat();
      if (analyticsChatInput && analyticsChatInput.focus) analyticsChatInput.focus();
    });
  }
  if (analyticsChatScreen) {
    analyticsChatScreen.addEventListener('click', function (event) {
      var toggleButton = event.target && event.target.closest && event.target.closest('[data-analytics-prompt-toggle]');
      if (toggleButton) {
        analyticsPromptPanelHidden = !analyticsPromptPanelHidden;
        settings.setBool(STORAGE_KEYS.analyticsPromptPanelCollapsed, analyticsPromptPanelHidden);
        renderAnalyticsSuggestions();
        return;
      }
      var definitionButton = event.target && event.target.closest && event.target.closest('[data-analytics-definition]');
      if (definitionButton) {
        var encoded = definitionButton.getAttribute('data-analytics-definition') || '';
        try {
          openAnalyticsDefinitionDialog(JSON.parse(decodeURIComponent(encoded)));
        } catch (_err) {
          openAnalyticsDefinitionDialog({});
        }
        return;
      }
      var openDefinitionButton = event.target && event.target.closest && event.target.closest('[data-analytics-open-definition]');
      if (openDefinitionButton) {
        var openEncoded = openDefinitionButton.getAttribute('data-analytics-open-definition') || '';
        try {
          openAnalyticsDefinitionInEditor(JSON.parse(decodeURIComponent(openEncoded)));
        } catch (_err) {
          openAnalyticsDefinitionInEditor({});
        }
        return;
      }
      var mcpToggle = event.target && event.target.closest && event.target.closest('[data-analytics-mcp-server]');
      if (mcpToggle) {
        setMcpServerEnabled(mcpToggle);
        return;
      }
      var button = event.target && event.target.closest && event.target.closest('[data-analytics-prompt]');
      if (!button) return;
      var prompt = button.getAttribute('data-analytics-prompt') || '';
      if (analyticsChatInput) analyticsChatInput.value = '';
      askAnalytics(prompt);
    });
  }
  if (historySessionFilterSelect) {
    historySessionFilterSelect.addEventListener('change', function () {
      historySessionFilter = historySessionFilterSelect.value || 'all';
      renderHistory(lastDashboard, true);
    });
  }
  [historyOverviewTab, historyFlightLogTab].forEach(function (tab) {
    if (!tab) return;
    tab.addEventListener('click', function () {
      historyTab = tab.getAttribute('data-history-tab') || 'overview';
      historyTab = normalizeHistoryTab(historyTab);
      safeSet(STORAGE_KEYS.historyTab, historyTab);
      flightLogCopyStatus = '';
      liveFingerprints.history = '';
      renderHistory(lastDashboard, true);
      if (historyTab === 'flight-log') loadFlightLogDigest(false);
    });
  });
  if (historyFlightLogContent) {
    historyFlightLogContent.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var monthButton = target.closest('[data-flight-log-month]');
      if (monthButton) {
        flightLogMonth = clampSelectableMonth(shiftMonth(flightLogMonth, Number(monthButton.getAttribute('data-flight-log-month') || 0)));
        flightLogSelectedDay = lastSelectableDayForMonth(flightLogMonth);
        flightLogCopyStatus = '';
        flightLogExpandedExports = {};
        liveFingerprints.history = '';
        loadFlightLogDigest(true);
        return;
      }
      var todayButton = target.closest('[data-flight-log-today]');
      if (todayButton) {
        flightLogSelectedDay = localDayString(new Date());
        flightLogMonth = flightLogSelectedDay.slice(0, 7);
        flightLogCopyStatus = '';
        flightLogExpandedExports = {};
        liveFingerprints.history = '';
        loadFlightLogDigest(true);
        return;
      }
      var dayButton = target.closest('[data-flight-log-day]');
      if (dayButton) {
        flightLogSelectedDay = dayButton.getAttribute('data-flight-log-day') || flightLogSelectedDay;
        flightLogMonth = flightLogSelectedDay.slice(0, 7);
        flightLogCopyStatus = '';
        flightLogExpandedExports = {};
        liveFingerprints.history = '';
        loadFlightLogDigest(true);
        return;
      }
      var exportButton = target.closest('[data-flight-log-export]');
      if (exportButton) {
        copyFlightLogExport(exportButton.getAttribute('data-flight-log-export') || '');
        return;
      }
    });
    historyFlightLogContent.addEventListener('change', function (event) {
      var target = event.target;
      if (!target || !target.matches) return;
      if (!target.matches('[data-flight-log-month-select]') && !target.matches('[data-flight-log-year-select]')) return;
      var monthSelect = historyFlightLogContent.querySelector('[data-flight-log-month-select]');
      var yearSelect = historyFlightLogContent.querySelector('[data-flight-log-year-select]');
      var yearLabel = historyFlightLogContent.querySelector('[data-flight-log-year-label]');
      var month = monthSelect && monthSelect.value ? monthSelect.value : flightLogMonth.slice(5, 7);
      var year = yearSelect && yearSelect.value ? yearSelect.value : (yearLabel && yearLabel.getAttribute('data-year')) || flightLogMonth.slice(0, 4);
      flightLogMonth = clampSelectableMonth(year + '-' + month);
      flightLogSelectedDay = lastSelectableDayForMonth(flightLogMonth);
      flightLogCopyStatus = '';
      flightLogExpandedExports = {};
      liveFingerprints.history = '';
      loadFlightLogDigest(true);
    });
    historyFlightLogContent.addEventListener('toggle', function (event) {
      var target = event.target;
      if (!target || !target.matches || !target.matches('[data-flight-log-export-panel]')) return;
      var kind = target.getAttribute('data-flight-log-export-panel') || '';
      if (!kind) return;
      flightLogExpandedExports[kind] = !!target.open;
    }, true);
    historyFlightLogContent.addEventListener('pointerover', function (event) {
      updateHistoryChartReadout(event.target, event);
    });
    historyFlightLogContent.addEventListener('pointermove', function (event) {
      updateHistoryChartReadout(event.target, event);
    });
    historyFlightLogContent.addEventListener('focusin', function (event) {
      updateHistoryChartReadout(event.target, event);
    });
    historyFlightLogContent.addEventListener('focusout', function (event) {
      hideHistoryChartReadout(event.target);
    });
  }
  if (historyContent) {
    historyContent.addEventListener('pointerover', function (event) {
      updateHistoryChartReadout(event.target, event);
    });
    historyContent.addEventListener('pointermove', function (event) {
      updateHistoryChartReadout(event.target, event);
    });
    historyContent.addEventListener('mouseover', function (event) {
      updateHistoryChartReadout(event.target, event);
    });
    historyContent.addEventListener('mousemove', function (event) {
      updateHistoryChartReadout(event.target, event);
    });
    historyContent.addEventListener('focusin', function (event) {
      updateHistoryChartReadout(event.target, event);
    });
    historyContent.addEventListener('focusout', function (event) {
      hideHistoryChartReadout(event.target);
    });
  }
  window.addEventListener('hashchange', function () {
    applyAppRoute(routeFromHash(), { syncHash: false, focus: true });
  });
  window.addEventListener('resize', function () {
    if (appRoute === 'history') scheduleHistoryBarShapeRefresh();
  });
  applyAppRoute(appRoute, { syncHash: false, focus: false });

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
    if (event.key === 'Escape' && attentionOverlay && attentionOverlay.classList.contains('visible')) {
      closeAttentionCenter();
      return;
    }
    if (event.key === 'Escape' && schemaDriftOverlay && schemaDriftOverlay.classList.contains('visible')) {
      closeSchemaDriftDialog();
      return;
    }
    if (event.key === 'Escape' && analyticsTokenNotice && analyticsTokenNotice.classList.contains('visible')) {
      closeAnalyticsTokenNotice();
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
  var panelsHidden = settings.getBool(STORAGE_KEYS.panelsHidden);

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
      var panelsAvailable = appRoute === 'mission';
      panelsBtn.innerHTML = panelsHidden ? ICON_EYE_SLASH : ICON_EYE_OPEN;
      panelsBtn.title = panelsAvailable
        ? (panelsHidden ? 'Show side panels' : 'Hide side panels for focus mode')
        : 'Panel visibility is only available on Home';
      panelsBtn.setAttribute('aria-label', panelsBtn.title);
      panelsBtn.setAttribute('aria-pressed', panelsHidden ? 'true' : 'false');
      panelsBtn.toggleAttribute('disabled', !panelsAvailable);
    }
    if (typeof window.__cmcSetPanelsHidden === 'function') {
      window.__cmcSetPanelsHidden(panelsHidden);
    }
  }

  function togglePanels() {
    if (appRoute !== 'mission') return;
    panelsHidden = !panelsHidden;
    settings.setBool(STORAGE_KEYS.panelsHidden, panelsHidden);
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
      openExternalUrl('https://github.com/DanWahlin/agent-mission-control/releases/latest').catch(function (err) {
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
