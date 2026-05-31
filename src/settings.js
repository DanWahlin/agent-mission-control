// Shared persisted app settings.
//
// Keep all localStorage keys here so renderer surfaces use one registry for
// preferences that must survive app reloads.
(function () {
  'use strict';

  var keys = Object.freeze({
    theme: 'cmc_theme',
    appTheme: 'cmc_app_theme',
    analyticsPromptPanelCollapsed: 'cmc_analytics_prompt_panel_collapsed',
    analyticsTokenNoticeSeen: 'cmc_analytics_token_notice_seen',
    panelsHidden: 'cmc_panels_hidden',
    schemaDriftDismissed: 'cmc_schema_drift_dismissed',
    missionPrefs: 'cmc_prefs',
  });

  function get(key) {
    try { return window.localStorage && window.localStorage.getItem(key); }
    catch (_err) { return null; }
  }

  function set(key, value) {
    try { window.localStorage && window.localStorage.setItem(key, String(value)); }
    catch (_err) { /* quota/private mode is non-fatal */ }
  }

  function getBool(key) {
    return get(key) === '1';
  }

  function setBool(key, value) {
    set(key, value ? '1' : '0');
  }

  function getJson(key, fallback) {
    var raw = get(key);
    if (!raw) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (_err) {
      return fallback;
    }
  }

  function setJson(key, value) {
    try { window.localStorage && window.localStorage.setItem(key, JSON.stringify(value)); }
    catch (_err) { /* quota/private mode is non-fatal */ }
  }

  window.__cmcSettings = Object.freeze({
    keys: keys,
    get: get,
    set: set,
    getBool: getBool,
    setBool: setBool,
    getJson: getJson,
    setJson: setJson,
  });
}());
