import { isPrerelease, expectedTag, version } from './resolve-tag.mjs'

// Runs on every `npm publish` (including a bare one). Block prerelease versions
// from defaulting onto the `latest` dist-tag.
const tag = process.env.npm_config_tag || 'latest'
if (isPrerelease && tag !== expectedTag) {
  console.error(
    `Refusing to publish prerelease ${version} to dist-tag "${tag}". ` +
      `Run "npm run publish:auto" or "npm publish --tag ${expectedTag}".`,
  )
  process.exit(1)
}
