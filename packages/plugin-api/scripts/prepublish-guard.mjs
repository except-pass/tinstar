import { expectedTag, version } from './resolve-tag.mjs'

// Runs on every `npm publish` (including a bare one). Enforce the version-to-tag
// mapping so a prerelease never lands on `latest` and a stable version never
// lands on `dev`.
const tag = process.env.npm_config_tag || 'latest'
if (tag !== expectedTag) {
  console.error(
    `Refusing to publish ${version} to dist-tag "${tag}". ` +
      `Run "npm run publish:auto" or "npm publish --tag ${expectedTag}".`,
  )
  process.exit(1)
}
