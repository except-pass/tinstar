import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

// Prerelease versions (e.g. 5.1.0-dev.0) must never land on the `latest` dist-tag.
export const isPrerelease = version.includes('-')
export const expectedTag = isPrerelease ? 'dev' : 'latest'
export { version }
