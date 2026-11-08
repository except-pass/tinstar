/** Ordered path rules, never inferred architecture or LLM output. */
export const footprintCategories = ['Code', 'Config', 'Tests', 'Generated & Dependencies', 'Docs', 'Other'] as const
export type FootprintCategory = typeof footprintCategories[number]
export interface PullFile {
  filename: string; previousFilename: string | null; status: string
  additions: number; deletions: number; changes: number
  category: FootprintCategory; url: string
}
export interface PullFootprint {
  head: string; baseHead: string; files: PullFile[]; expectedFiles: number
  complete: boolean; observedAt: string; freshness: 'fresh' | 'stale'; error: string | null
}
export function fileCategory(filename: string): FootprintCategory {
  const path = filename.toLowerCase(), name = path.split('/').at(-1) ?? path
  if (/(^|\/)(node_modules|vendor|vendored|generated|__generated__|dist|build|coverage)(\/|$)/.test(path) || /(^|[._-])(generated|gen|min)\./.test(name) || /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|gemfile\.lock|poetry\.lock|uv\.lock|pipfile\.lock|composer\.lock|go\.sum|packages\.lock\.json)$/.test(name)) return 'Generated & Dependencies'
  if (/(^|\/)(__tests__|tests?|specs?|e2e|fixtures?|__fixtures__|test-fixtures|cypress|playwright)(\/|$)/.test(path) || /(^test_|[._-](test|spec)[._-])/.test(name) || /^(conftest|pytest)\./.test(name)) return 'Tests'
  if (/(^|\/)(docs?|documentation)(\/|$)/.test(path) || /\.(md|mdx|rst|adoc|txt)$/.test(name) || /^(readme|license|changelog|authors|notice)(\.|$)/.test(name)) return 'Docs'
  if (/(^|\/)(\.github|\.circleci|\.config|config|configs)(\/|$)/.test(path) || /\.(jsonc?|ya?ml|toml|ini|cfg|conf|properties)$/.test(name) || /(^|[._-])(config|settings|rc)\./.test(name) || /^\.(env|[\w-]+rc)(\.|$)/.test(name) || /^(dockerfile|compose|makefile|cmakelists\.txt)(\.|$)/.test(name)) return 'Config'
  if (/\.(tsx?|jsx?|mjs|cjs|vue|svelte|css|scss|sass|less|html?|py|pyi|go|rs|c|h|cc|cpp|hpp|cs|java|kt|kts|rb|php|swift|m|mm|sh|bash|zsh|ps1|sql|graphql|gql|proto|ex|exs|erl|hs|lua|r|jl|dart|scala|clj|cljs|tf|svg)$/.test(name)) return 'Code'
  return 'Other'
}
export function footprintTotals(files: PullFile[], excludeGenerated = false) {
  const included = files.filter(file => !excludeGenerated || file.category !== 'Generated & Dependencies')
  const total = included.reduce((sum, file) => sum + file.additions + file.deletions, 0)
  return { total, handwrittenCode: files.filter(file => file.category === 'Code').reduce((sum, file) => sum + file.additions + file.deletions, 0),
    categories: footprintCategories.filter(category => !excludeGenerated || category !== 'Generated & Dependencies').map(category => {
      const rows = included.filter(file => file.category === category), lines = rows.reduce((sum, file) => sum + file.additions + file.deletions, 0)
      return { category, files: rows.length, lines, percent: total ? lines / total * 100 : 0 }
    }) }
}
