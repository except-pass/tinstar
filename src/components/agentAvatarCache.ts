/**
 * Client-side DiceBear avatar cache.
 *
 * Avatars are a pure function of (seed, color). They are generated lazily
 * on first request: the first call kicks off a dynamic import of DiceBear
 * and returns null. When the library has resolved and the SVG has been
 * rendered, it is stored in a module-level Map and all subsequent calls
 * return the cached data URL synchronously.
 *
 * Consumers should treat a null return as "not ready yet — render a
 * placeholder" and re-request on the next tick / state change (or listen
 * via subscribeAvatarCache).
 */

type Loaded = {
  createAvatar: typeof import('@dicebear/core').createAvatar
  botttsNeutral: typeof import('@dicebear/collection').botttsNeutral
}

let loadedPromise: Promise<Loaded> | null = null
let loaded: Loaded | null = null
const cache = new Map<string, string>()
const pending = new Set<string>()
const listeners = new Set<() => void>()

function keyOf(seed: string, color: string): string {
  return `${seed}:${color}`
}

function ensureLoaded(): Promise<Loaded> {
  if (loaded) return Promise.resolve(loaded)
  if (!loadedPromise) {
    loadedPromise = Promise.all([
      import('@dicebear/core'),
      import('@dicebear/collection'),
    ]).then(([core, col]) => {
      loaded = { createAvatar: core.createAvatar, botttsNeutral: col.botttsNeutral }
      return loaded
    })
  }
  return loadedPromise
}

function notify(): void {
  for (const fn of listeners) fn()
}

/**
 * Get the cached avatar data URL, or null if it's not yet rendered.
 * On null, kicks off async generation that will fill the cache; subscribe
 * via subscribeAvatarCache to be notified when the avatar becomes ready.
 */
export function getAvatarDataUrl(seed: string, color: string): string | null {
  const k = keyOf(seed, color)
  const hit = cache.get(k)
  if (hit) return hit
  if (pending.has(k)) return null
  pending.add(k)
  ensureLoaded().then(({ createAvatar, botttsNeutral }) => {
    try {
      // Use DiceBear's default vibrant palette for the bot body. The run's
      // accent color lives on the ring around the avatar (see AgentAvatar.tsx),
      // not on the face itself — mixing them made every face render near-black
      // because bottts-neutral's body uses the primary color for everything.
      // Keep the background transparent so the bot reads against any HUD cell bg.
      const svg = createAvatar(botttsNeutral, {
        seed,
        backgroundColor: ['transparent'],
      }).toString()
      const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
      cache.set(k, dataUrl)
    } catch {
      // Leave the cache empty; consumers fall back to the placeholder.
    } finally {
      pending.delete(k)
      notify()
    }
  }).catch(() => {
    pending.delete(k)
    notify()
  })
  return null
}

/** Subscribe to cache updates. Returns an unsubscribe function. */
export function subscribeAvatarCache(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test-only: reset all state between test cases. */
export function __resetAvatarCacheForTests(): void {
  cache.clear()
  pending.clear()
  listeners.clear()
  loaded = null
  loadedPromise = null
}
