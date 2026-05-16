// bin/tinstar/help.js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

export function buildIndex(rootDir) {
  const index = {}
  if (!fs.existsSync(rootDir)) return index
  for (const file of walk(rootDir)) {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = matter(raw)
    const title = parsed.data?.title
    if (!title) continue
    const slug = parsed.data.slug
      || path.relative(rootDir, file).replace(/\.md$/, '').replace(/\\/g, '/')
    index[slug] = {
      title,
      description: parsed.data.description || '',
      file,
      content: parsed.content,
    }
  }
  return index
}

function findDocsRoot() {
  return path.resolve(__dirname, '../../docs')
}

export async function run(argv) {
  const docsRoot = findDocsRoot()
  const index = buildIndex(docsRoot)
  const slug = argv[3]
  if (!slug) {
    console.log('Topics:\n')
    const sorted = Object.entries(index).sort(([a], [b]) => a.localeCompare(b))
    for (const [s, t] of sorted) {
      console.log(`  ${s.padEnd(24)} ${t.description}`)
    }
    return
  }
  const topic = index[slug]
  if (!topic) {
    console.error(`unknown topic: ${slug}`)
    console.error(`available: ${Object.keys(index).sort().join(', ')}`)
    process.exit(1)
  }
  console.log(`# ${topic.title}\n`)
  console.log(topic.content.trim())
}
