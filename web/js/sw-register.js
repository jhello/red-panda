(function () {
  'use strict';

  // Register the offline shell Service Worker only on HTTP(S) HTML5 deployments.
  // Android WebView serves assets from file:///android_asset/www/, which is
  // already bundled locally and does not use Service Workers.
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // Offline cache is a progressive enhancement; ignore registration failures
      // (for example on plain HTTP LAN origins where browsers restrict SW).
    });
  });
})();
