import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'

let sha = null
try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* Packaged source may lack Git; report unknown. */ }
await build({ entryPoints: ['src/server/standalone.ts', 'src/server/actions/brokerMain.ts', 'src/server/reconciliation/tunnelMain.ts'],
  entryNames: '[name]', bundle: true, platform: 'node', format: 'esm', outdir: 'dist/server', external: ['http-proxy'],
  define: { __TINSTAR_BUILD_SHA__: JSON.stringify(sha) },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
