import '@testing-library/jest-dom/vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * No test may touch the developer's real `~/.config/tinstar`.
 *
 * This is not hygiene. A route test that drove `POST /api/reach {"enabled":false}`
 * reached the real coordinator through the real `getConfigRoot()`, rewrote the
 * operator's stored reach preference, and asked tailscale to take their live
 * tailnet mapping down — so running the unit suite silently turned off a feature
 * on the machine running it. The evidence was a `reach/preference.json` sitting in
 * a real config dir that no operator had asked for.
 *
 * Pinning it here rather than per-test is deliberate: the failure mode is a test
 * that FORGOT to isolate, so the default has to be safe. An explicit
 * TINSTAR_CONFIG_HOME still wins, which is what lets a test opt into a root it
 * controls and assert against it.
 */
if (!process.env.TINSTAR_CONFIG_HOME && !process.env.TINSTAR_DATA_DIR) {
  process.env.TINSTAR_CONFIG_HOME = mkdtempSync(`${tmpdir()}/tinstar-test-config-`)
}
