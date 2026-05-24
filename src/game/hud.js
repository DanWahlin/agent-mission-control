// Copilot Mission Control — slim DOM HUD.
//
// Responsibilities (deliberately tiny):
//   - Theme toggle (sun/moon) that flips body.theme-light and persists
//     the choice in `cmc_theme` localStorage. The Phaser scene listens
//     via `window.__cmcSetTheme(mode)` and re-renders with light/dark
//     color tokens.
//   - Ops status surface in the top bar (chip + recommendation +
//     alerts badge). The scene calls `window.__cmcUpdateOps(summary,
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
  var currentTheme = safeGet('cmc_theme') === 'light' ? 'light' : 'dark';

  function applyTheme() {
    var isLight = currentTheme === 'light';
    document.body.classList.toggle('theme-light', isLight);
    if (themeBtn) {
      // Show the icon for the mode you'll switch INTO.
      themeBtn.textContent = isLight ? '🌙' : '☀️';
      themeBtn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
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
  window.__cmcUpdateOps = function (summary, alerts) {
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

  // -------------------------------------------------------------------
  // HTML Inspector overlay. Phaser owns the map; this DOM view owns the
  // dense drill-down so native scrolling/wrapping/keyboard close work
  // like a normal desktop dialog.
  // -------------------------------------------------------------------

  var inspectorOverlay = $('inspector-overlay');
  var inspectorTitle = $('inspector-title');
  var inspectorSubtitle = $('inspector-subtitle');
  var inspectorClose = $('inspector-close');
  var inspectorTabs = $('inspector-tabs');
  var inspectorList = $('inspector-list');
  var inspectorDetail = $('inspector-detail');
  var inspectorSession = null;
  var inspectorMode = 'tools';
  var inspectorTab = 'all';
  var selectedToolKey = '';
  var selectedTurnId = '';

  var TOOL_TABS = [
    { id: 'all', label: 'All' },
    { id: 'mcp', label: 'MCP' },
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
    return call && (call.call_id || [call.timestamp, call.tool, call.category].join('|'));
  }

  function callKindLabel(call) {
    var category = call && call.category;
    if (category === 'mcp') return 'MCP tool';
    if (category === 'skills') return 'Skill';
    if (category === 'delegates') return 'Sub-agent';
    if (category === 'terminal') return 'Command';
    if (category === 'signal') return 'Web/docs';
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

  function kvRows(rows) {
    return '<dl class="inspector-kv">' + rows.map(function (row) {
      return '<dt>' + escapeHtml(row[0]) + '</dt><dd>' + escapeHtml(row[1]) + '</dd>';
    }).join('') + '</dl>';
  }

  function renderTabs() {
    if (!inspectorTabs) return;
    if (inspectorMode !== 'tools') {
      inspectorTabs.innerHTML = '';
      inspectorTabs.hidden = true;
      return;
    }
    inspectorTabs.hidden = false;
    inspectorTabs.innerHTML = TOOL_TABS.map(function (tab) {
      return '<button class="inspector-pill ' + (inspectorTab === tab.id ? 'active' : '') + '" type="button" data-inspector-tab="' + tab.id + '">' + escapeHtml(tab.label) + '</button>';
    }).join('');
  }

  function renderToolList(calls, selected) {
    if (!inspectorList) return;
    if (!calls.length) {
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
    rows.push(['Raw args', 'hidden by privacy boundary']);
    rows.push(['Output', 'hidden by privacy boundary']);
    inspectorDetail.innerHTML = '<h3>Safe details</h3>' + kvRows(rows);
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
    var toolDetails = turnToolDetailList(turn);
    var rows = [
      ['Status', (turn.status || 'unknown') + (turn.partial ? ' · partial tail window' : '')],
      ['Started', (formatClock(turn.started_at) || 'unknown') + ' · ' + (turn.started_at || 'unknown')],
      ['Duration', turnDurationLabel(turn)],
      ['Tools', String(turn.tool_count || 0)],
      ['Ran', turnToolList(turn)],
      ['Tool details', toolDetails || 'none retained'],
      ['Failures', String(turn.failure_count || 0)],
      ['Categories', (turn.categories || []).join(', ') || 'none'],
      ['Model', turn.model || 'unknown'],
      ['Output', compactNumber(turn.output_tokens || 0) + ' tokens'],
    ];
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
      : '<div class="inspector-empty">No tool rows in the retained call window.</div>';
    inspectorDetail.innerHTML = '<h3>Turn story</h3>' + kvRows(rows)
      + '<div class="inspector-related-title">Tools in this turn (' + related.length + ')</div>'
      + relatedHtml;
  }

  function renderInspector() {
    if (!inspectorSession) return;
    if (inspectorTitle) inspectorTitle.textContent = 'Inspector · ' + (inspectorSession.title || inspectorSession.id || 'session');
    if (inspectorSubtitle) {
      var calls = (inspectorSession.recent_tool_calls || []).length;
      var turns = (inspectorSession.recent_turns || []).length;
      inspectorSubtitle.textContent = (inspectorSession.repository || 'unknown repo') + ' / ' + (inspectorSession.branch || 'unknown') + ' · ' + calls + ' calls · ' + turns + ' turns';
    }
    document.querySelectorAll('[data-inspector-mode]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-inspector-mode') === inspectorMode);
    });
    renderTabs();
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

  function openInspector(session) {
    if (!inspectorOverlay || !session) return false;
    inspectorSession = session;
    inspectorMode = 'tools';
    inspectorTab = 'all';
    selectedToolKey = '';
    selectedTurnId = '';
    inspectorOverlay.classList.add('visible');
    inspectorOverlay.setAttribute('aria-hidden', 'false');
    renderInspector();
    setTimeout(function () { if (inspectorList) inspectorList.focus(); }, 0);
    return true;
  }

  function closeInspector() {
    if (!inspectorOverlay) return;
    inspectorOverlay.classList.remove('visible');
    inspectorOverlay.setAttribute('aria-hidden', 'true');
  }

  window.__cmcOpenInspector = openInspector;
  window.__cmcCloseInspector = closeInspector;

  if (inspectorClose) inspectorClose.addEventListener('click', closeInspector);
  if (inspectorOverlay) {
    inspectorOverlay.addEventListener('click', function (event) {
      if (event.target === inspectorOverlay) closeInspector();
    });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && inspectorOverlay && inspectorOverlay.classList.contains('visible')) {
      closeInspector();
    }
  });
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var modeBtn = target.closest('[data-inspector-mode]');
    if (modeBtn) {
      inspectorMode = modeBtn.getAttribute('data-inspector-mode') || 'tools';
      renderInspector();
      return;
    }
    var tabBtn = target.closest('[data-inspector-tab]');
    if (tabBtn) {
      inspectorTab = tabBtn.getAttribute('data-inspector-tab') || 'all';
      selectedToolKey = '';
      renderInspector();
      return;
    }
    var toolBtn = target.closest('[data-tool-key]');
    if (toolBtn) {
      selectedToolKey = toolBtn.getAttribute('data-tool-key') || '';
      renderInspector();
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

  var topbarMetrics = $('topbar-metrics');
  var domSession = $('dom-session');
  var domWorkMix = $('dom-workmix');
  var domFeed = $('dom-feed');
  var domQuarter = $('dom-quarter');
  var domReplay = $('dom-replay');
  var domLoading = $('dashboard-loading');
  var lastDashboard = null;
  var workMixScope = 'selected';

  var CATEGORY_COLORS = {
    forge: '#f0911d',
    library: '#e1ae45',
    terminal: '#86d4b7',
    signal: '#c37ee8',
    delegates: '#fc60c7',
    skills: '#da58e0',
    court: '#2fc5e8',
    mcp: '#45cea5',
    alert: '#ff5252',
  };

  function setPanelRect(el, rect) {
    if (!el || !rect) return;
    el.style.left = Math.round(rect.x) + 'px';
    el.style.top = Math.round(rect.y) + 'px';
    el.style.width = Math.round(rect.w) + 'px';
    el.style.height = Math.round(rect.h) + 'px';
  }

  function panelBody(el) {
    return el && el.querySelector('.cmc-panel-body');
  }

  function statusColor(status) {
    var isLight = document.body.classList.contains('theme-light');
    if (isLight) {
      if (status === 'needs-attention') return '#b91c1c';
      if (status === 'working') return '#15803d';
      if (status === 'thinking') return '#0369a1';
      if (status === 'waiting') return '#92400e';
      return '#64748b';
    }
    if (status === 'needs-attention') return '#ff5252';
    if (status === 'working') return '#60ff9a';
    if (status === 'thinking') return '#61d6ff';
    if (status === 'waiting') return '#ffd54a';
    return '#8c9ac8';
  }

  function eventLabel(kind, category) {
    if (!kind && !category) return 'none';
    if (kind === 'tool.execution_start') return 'tool started';
    if (kind === 'tool.execution_complete') return category === 'alert' ? 'tool failed' : 'tool completed';
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

  function ageLabel(seconds) {
    if (seconds == null || Number.isNaN(Number(seconds))) return 'unknown';
    var n = Number(seconds);
    if (n < 60) return n + 's';
    if (n < 3600) return Math.floor(n / 60) + 'm';
    return Math.floor(n / 3600) + 'h';
  }

  function topbarMetricLabel(label) {
    if (label === 'Tokens · 24h') return 'Tokens';
    return label;
  }

  function renderTopbarMetrics(view) {
    if (!topbarMetrics) return;
    var cards = (view.summary && view.summary.cards) || [];
    topbarMetrics.innerHTML = cards.slice(0, 4).map(function (card) {
      var label = topbarMetricLabel(card.label || '');
      var value = label === 'Tokens' ? (card.subCompact || card.value || '0') : (card.value || '0');
      var sub = card.subCompact || card.sub || '';
      return '<span class="topbar-metric" title="' + escapeHtml(label + (sub ? ': ' + sub : '')) + '">'
        + '<span class="topbar-metric-label">' + escapeHtml(label) + '</span>'
        + '<span class="topbar-metric-value" style="--metric-color:' + escapeHtml(card.color || '#ffd54a') + '">' + escapeHtml(value) + '</span>'
        + '</span>';
    }).join('');
  }

  function renderWorkMixRows(mix, className) {
    var max = Math.max(1, ...mix.map(function (row) { return row.value || 0; }));
    return '<div class="cmc-workmix ' + escapeHtml(className || '') + '"><div class="cmc-workmix-title">Recent work mix · last 24h</div>'
      + mix.map(function (row) {
        var color = CATEGORY_COLORS[row.category] || '#9aa6c8';
        return '<div class="cmc-work-row"><span>' + escapeHtml(row.label) + '</span><div class="cmc-bar"><span style="--bar-color:' + color + ';width:' + Math.max(8, (row.value / max) * 100) + '%"></span></div><span class="cmc-muted">' + escapeHtml(row.value) + '</span></div>';
      }).join('') + '</div>';
  }

  function mixRowsFromCounts(counts) {
    var c = counts || {};
    return [
      { label: 'Read', value: Number(c.read || 0), category: 'library' },
      { label: 'Edit', value: Number(c.write || 0), category: 'forge' },
      { label: 'Cmd', value: Number(c.command || 0), category: 'terminal' },
      { label: 'Web', value: Number(c.web || 0), category: 'signal' },
      { label: 'Agent', value: Number(c.task || 0), category: 'delegates' },
      { label: 'MCP', value: Number(c.mcp || 0), category: 'mcp' },
    ];
  }

  function aggregateSessionMix(options, activeOnly) {
    var base = { read: 0, write: 0, command: 0, web: 0, task: 0, mcp: 0 };
    var list = (options || []).filter(function (opt) {
      return !activeOnly || !!opt.isActive;
    });
    if (!list.length && activeOnly) list = options || [];
    list.forEach(function (opt) {
      var mix = opt.mix || {};
      base.read += Number(mix.read || 0);
      base.write += Number(mix.write || 0);
      base.command += Number(mix.command || 0);
      base.web += Number(mix.web || 0);
      base.task += Number(mix.task || 0);
      base.mcp += Number(mix.mcp || 0);
    });
    return mixRowsFromCounts(base);
  }

  function renderWorkMixPanel(view) {
    var body = panelBody(domWorkMix);
    if (!body) return;
    var options = (view.sessions && view.sessions.options) || [];
    var selected = view.sessions && view.sessions.selected;
    var selectedOption = selected
      ? options.find(function (opt) { return opt.id === selected.id; })
      : null;

    if (workMixScope === 'selected' && !selectedOption) workMixScope = 'running';
    if (workMixScope.indexOf('session:') === 0) {
      var id = workMixScope.slice('session:'.length);
      if (!options.some(function (opt) { return opt.id === id; })) workMixScope = 'running';
    }

    var mixRows = (view.summary && view.summary.workMix) || [];
    if (workMixScope === 'selected' && selectedOption) {
      mixRows = mixRowsFromCounts(selectedOption.mix);
    } else if (workMixScope === 'running') {
      mixRows = aggregateSessionMix(options, true);
    } else if (workMixScope.indexOf('session:') === 0) {
      var scopedId = workMixScope.slice('session:'.length);
      var scoped = options.find(function (opt) { return opt.id === scopedId; });
      mixRows = mixRowsFromCounts(scoped && scoped.mix);
    }

    var choices = [
      '<option value="running"' + (workMixScope === 'running' ? ' selected' : '') + '>Running sessions (combined)</option>',
    ];
    if (selectedOption) {
      choices.unshift('<option value="selected"' + (workMixScope === 'selected' ? ' selected' : '') + '>Selected session</option>');
    }
    options.forEach(function (opt) {
      choices.push('<option value="session:' + escapeHtml(opt.id) + '"' + (workMixScope === 'session:' + opt.id ? ' selected' : '') + '>'
        + escapeHtml((opt.title || opt.id) + ' · ' + (opt.shortId || opt.id.slice(0, 8)))
        + '</option>');
    });

    body.innerHTML = '<div class="cmc-workmix-controls"><label class="cmc-muted" for="workmix-scope-select">Scope</label>'
      + '<select id="workmix-scope-select" class="cmc-select" data-cmc-action="workmix-scope">' + choices.join('') + '</select></div>'
      + renderWorkMixRows(mixRows, '');
  }

  function renderSession(view) {
    var body = panelBody(domSession);
    if (!body) return;
    var selected = view.sessions && view.sessions.selected;
    var options = (view.sessions && view.sessions.options) || [];
    if (!options.length) {
      body.innerHTML = '<div class="cmc-label">No running Copilot sessions found. Start Copilot CLI and this panel will show the active task.</div>';
      return;
    }
    var selectedId = selected && selected.id;
    var picker = '<div class="cmc-label" style="margin-bottom:8px">' + escapeHtml(view.sessions.header || '') + '</div>'
      + '<div class="cmc-session-picker"><select class="cmc-select" data-cmc-action="session-select">'
      + options.map(function (opt) {
        var marker = opt.isActive ? '● ' : '○ ';
        return '<option value="' + escapeHtml(opt.id) + '"' + (opt.id === selectedId ? ' selected' : '') + '>'
          + escapeHtml(marker + (opt.title || opt.id) + ' · ' + (opt.shortId || opt.id.slice(0, 8)))
          + '</option>';
      }).join('')
      + '</select></div>';
    var selectedHtml = '';
    if (selected) {
      var inTok = selected.input_tokens || 0;
      var outTok = selected.output_tokens || 0;
      var tcalls = (selected.recent_tool_calls || []).length;
      var hasGitRoot = !!selected.git_root;
      selectedHtml = '<div class="cmc-detail-rows">'
        + '<div style="color:' + statusColor(selected.status) + '">Status: ' + escapeHtml(selected.status) + '</div>'
        + '<div>Last: ' + escapeHtml(eventLabel(selected.last_event_kind, selected.last_event_category)) + '</div>'
        + '<div class="cmc-muted">Tool: ' + escapeHtml(selected.last_tool || 'none') + '</div>'
        + '<div class="cmc-muted">Age: ' + escapeHtml(ageLabel(selected.stale_seconds)) + '</div>'
        + '<div class="cmc-muted">Tokens: ' + compactNumberShort(inTok) + '/' + compactNumberShort(outTok) + '</div>'
        + '</div>'
        + '<div class="cmc-actions">'
        + '<button class="cmc-button accent ' + (hasGitRoot ? '' : 'disabled') + '" ' + (hasGitRoot ? 'data-cmc-action="editor"' : 'disabled aria-disabled="true"') + '>↗ Open in Editor</button>'
        + '<button class="cmc-button ' + (tcalls > 0 ? '' : 'disabled') + '" ' + (tcalls > 0 ? 'data-cmc-action="inspector"' : 'disabled aria-disabled="true"') + '>Inspector (' + tcalls + ')</button>'
        + '</div>';
    }
    body.innerHTML = picker + selectedHtml;
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

  function renderQuarter(view) {
    if (!domQuarter) return;
    var title = domQuarter.querySelector('.cmc-panel-title');
    var body = panelBody(domQuarter);
    var q = view.quarter;
    if (title) title.textContent = q ? q.title : 'Sector';
    if (!body || !q) return;
    domQuarter.style.setProperty('--quarter-color', q.color || CATEGORY_COLORS[q.category] || '#ffd54a');
    body.innerHTML = '<div class="cmc-quarter-line">' + escapeHtml(q.countLine) + '</div>'
      + '<div class="cmc-quarter-line">' + escapeHtml(q.line) + '</div>'
      + (q.toolList ? '<div class="cmc-quarter-tools cmc-muted">' + escapeHtml(q.toolList) + '</div>' : '')
      + (q.footer ? '<div class="cmc-quarter-footer ' + (q.footerAlert ? 'cmc-footer-alert' : 'cmc-footer-info') + '">' + escapeHtml(q.footer) + '</div>' : '');
  }

  function renderReplay(view) {
    if (!domReplay) return;
    var replay = view.replay || { total: 0, cursor: 0, paused: false, atLive: true, status: 'waiting for events' };
    var pct = replay.total > 0 ? Math.max(0, Math.min(100, (replay.cursor / replay.total) * 100)) : 0;
    domReplay.innerHTML = '<div class="cmc-replay-inner">'
      + '<button class="cmc-button" data-cmc-action="replay-toggle">' + (replay.paused ? '▶' : '⏸') + '</button>'
      + '<div class="cmc-replay-track" data-cmc-action="replay-seek"><div class="cmc-replay-rail"><div class="cmc-replay-fill" style="width:' + pct + '%"></div></div><div class="cmc-replay-knob" style="left:' + pct + '%"></div><div class="cmc-replay-status">' + escapeHtml(replay.status) + '</div></div>'
      + '<button class="cmc-button" data-cmc-action="replay-live">' + (replay.atLive ? 'LIVE' : 'GO LIVE') + '</button>'
      + '</div>';
  }

  window.__cmcRenderDashboard = function (view) {
    lastDashboard = view;
    document.body.classList.add('dashboard-ready');
    if (domLoading) domLoading.setAttribute('aria-hidden', 'true');
    var l = view.layout || {};
    var hideSides = !!view.panelsHidden;
    var columnGap = l.compact ? 10 : 12;
    var replayTop = Number.isFinite(l.replayY) && l.replayH > 0 ? l.replayY : l.bottomY;
    var columnBottom = Math.max(l.topY || 0, replayTop - columnGap);
    var columnH = Math.max(0, columnBottom - (l.topY || 0));
    var feedMinH = l.compact ? 130 : 160;
    var workmixH = l.compact ? 232 : 244;
    var sessionMainH = l.compact ? 244 : 270;
    var maxSessionH = columnH - workmixH - feedMinH - columnGap * 2;
    if (maxSessionH < sessionMainH) {
      sessionMainH = Math.max(l.compact ? 218 : 238, maxSessionH);
    }
    var workmixY = (l.topY || 0) + sessionMainH + columnGap;
    var feedY = workmixY + workmixH + columnGap;
    var feedH = Math.max(80, columnBottom - feedY);
    setPanelRect(domSession, { x: l.leftX, y: l.topY, w: l.panelW, h: sessionMainH });
    setPanelRect(domWorkMix, { x: l.leftX, y: workmixY, w: l.panelW, h: workmixH });
    setPanelRect(domFeed, { x: l.leftX, y: feedY, w: l.panelW, h: feedH });
    setPanelRect(domQuarter, { x: l.bottomX, y: l.bottomY, w: l.bottomW, h: l.bottomH });
    setPanelRect(domReplay, { x: l.replayX, y: l.replayY, w: l.replayW, h: l.replayH });
    [domSession, domWorkMix, domFeed, domReplay].forEach(function (el) {
      if (el) el.classList.toggle('hidden', hideSides);
    });
    if (domQuarter) domQuarter.classList.toggle('hidden', false);
    renderTopbarMetrics(view);
    renderSession(view);
    renderWorkMixPanel(view);
    renderFeed(view);
    renderQuarter(view);
    renderReplay(view);
  };

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var sessionBtn = target.closest('[data-session-id]');
    if (sessionBtn && typeof window.__cmcSelectSession === 'function') {
      window.__cmcSelectSession(sessionBtn.getAttribute('data-session-id'));
      return;
    }
    var action = target.closest('[data-cmc-action]');
    if (!action) return;
    if (action.disabled || action.classList.contains('disabled')) return;
    var name = action.getAttribute('data-cmc-action');
    if (name === 'editor' && typeof window.__cmcOpenSelectedSessionInEditor === 'function') window.__cmcOpenSelectedSessionInEditor();
    if (name === 'inspector' && lastDashboard && lastDashboard.sessions && lastDashboard.sessions.selected) openInspector(lastDashboard.sessions.selected);
    if (name === 'replay-toggle' && typeof window.__cmcToggleReplayPause === 'function') window.__cmcToggleReplayPause();
    if (name === 'replay-live' && typeof window.__cmcJumpReplayToLive === 'function') window.__cmcJumpReplayToLive();
    if (name === 'replay-seek' && typeof window.__cmcSeekReplayRatio === 'function') {
      var rect = action.getBoundingClientRect();
      window.__cmcSeekReplayRatio((event.clientX - rect.left) / rect.width);
    }
  });

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.matches) return;
    if (target.matches('[data-cmc-action="workmix-scope"]')) {
      workMixScope = target.value || 'running';
      if (lastDashboard) renderWorkMixPanel(lastDashboard);
      return;
    }
    if (target.matches('[data-cmc-action="session-select"]') && typeof window.__cmcSelectSession === 'function') {
      window.__cmcSelectSession(target.value);
    }
  });

  // -------------------------------------------------------------------
  // Panels toggle — hide/show the Summary + Selected Session + Activity
  // Feed side panels so the castle/buildings ring can expand to take up
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
})();
