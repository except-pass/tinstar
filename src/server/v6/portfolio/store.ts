import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getConfigRoot } from '../../configRoot'
import { emptyPortfolio, portfolioFromUnknown } from '../../../v6/portfolio/model'
import type { PortfolioDoc } from '../../../v6/portfolio/types'

const chains = new Map<string, Promise<unknown>>()

export function resolvePortfolioFile(explicit?: string): { ok: true; file: string } | { ok: false; detail: string } {
  const root = resolve(getConfigRoot())
  const file = resolve(explicit ?? join(root, 'v6', 'portfolio.json'))
  const rel = relative(root, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    return { ok: false, detail: 'portfolio file is outside the config root' }
  }
  return { ok: true, file }
}

export function loadPortfolio(file: string): PortfolioDoc {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const parsed = portfolioFromUnknown(raw)
    if (!parsed.ok) throw new Error(parsed.diagnostic)
    return parsed.value
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') return emptyPortfolio()
    throw err
  }
}

export function savePortfolio(file: string, doc: PortfolioDoc): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

export async function updatePortfolio<T>(
  file: string,
  mutate: (doc: PortfolioDoc) => Promise<{ doc: PortfolioDoc; result: T }> | { doc: PortfolioDoc; result: T },
): Promise<T> {
  const prev = chains.get(file) ?? Promise.resolve()
  const run = prev.then(async () => {
    const doc = loadPortfolio(file)
    const out = await mutate(doc)
    if (out.doc !== doc) savePortfolio(file, out.doc)
    return out.result
  })
  chains.set(file, run.then(() => undefined, () => undefined))
  return run
}
