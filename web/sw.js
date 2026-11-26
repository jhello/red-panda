/* global self, caches, fetch */
'use strict';

const CACHE_VERSION = 'red-panda-shell-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './css/journey-memories.css',
  './css/settings-theme.css',
  './config.js',
  './connection.js',
  './js/i18n.js',
  './js/storage.js',
  './js/media.js',
  './js/backup.js',
  './js/sw-register.js',
  './app.js',
  './icon-192.png',
  './icon-512.png',
  './logo.png',
  './paintings/athens.jpg',
  './paintings/louvre.jpg',
  './paintings/neuschwanstein.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('red-panda-shell-') && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Network-first so online refreshes pick up new releases immediately, while
  // offline refreshes fall back to the cached shell without showing an error page.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        throw new Error('Offline and not cached');
      }),
  );
});
