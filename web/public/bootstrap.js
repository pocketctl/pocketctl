/*
 * M-8 external bootstrap (same-origin, served no-cache).
 *
 * Runs synchronously before the Vue bundle:
 *   1. applies the saved/system theme to <html> before first paint (FOUC);
 *   2. derives the API base and WebSocket URL for the app bundle.
 *
 * Constraints: no eval/Function, no dynamic <script> injection, and it never
 * reads the query string or any token — only location scheme/host.
 */
(function () {
  'use strict';

  // --- theme pre-initialization ---
  var theme = null;
  try {
    theme = window.localStorage.getItem('pocketctl-theme');
  } catch (e) {
    /* storage unavailable (private mode etc.) — fall through to system */
  }
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    document.documentElement.setAttribute('data-theme', 'light');
  }

  // --- environment globals for the app bundle ---
  window.__APP_BASE__ = location.protocol + '//' + location.host;
  window.__RELAY_WS__ = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
})();
