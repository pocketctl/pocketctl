import { classifyCacheRequest } from './sw-policy.js'

const CACHE_NAME = 'pocketctl-shell-v1'
const SHELL_URLS = [
  '/app/',
  '/app/offline.html',
  '/app/manifest.webmanifest',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png',
  '/app/icons/icon-maskable-512.png',
]

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS)))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith('pocketctl-') && key !== CACHE_NAME)
          .map(key => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  const network = fetch(request).then(async response => {
    if (response.ok) await cache.put(request, response.clone())
    return response
  })
  return cached || network
}

async function networkFirstNavigation(request) {
  try {
    return await fetch(request)
  } catch {
    const cache = await caches.open(CACHE_NAME)
    return (await cache.match('/app/offline.html')) || Response.error()
  }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  const strategy = classifyCacheRequest(event.request.url, self.location.origin, event.request.mode)
  if (strategy === 'cache-first') event.respondWith(cacheFirst(event.request))
  else if (strategy === 'stale-while-revalidate') event.respondWith(staleWhileRevalidate(event.request))
  else if (strategy === 'network-first') event.respondWith(networkFirstNavigation(event.request))
})
