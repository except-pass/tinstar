// Custom ESLint rule: flag Tailwind className tokens that target Tinstar's
// custom color palette but reference a key that doesn't exist.
//
// Motivation: utilities like `bg-surface-2` or `border-border` are valid
// Tailwind *syntax*, so they silently emit no CSS — the element renders with no
// background/border (transparent), which is invisible until someone sees a
// white-on-white input. tsc and the standard ESLint rules can't see inside
// className strings. This rule reads the real palette (tailwind.theme.js) and
// validates any utility that targets the custom namespaces, plus a denylist of
// shadcn-style color words that don't exist in this project.

import { colors } from '../tailwind.theme.js'

// namespace -> Set of valid subkeys (e.g. surface -> {base,panel,raised,hover})
const NAMESPACES = new Map(
  Object.entries(colors)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([ns, v]) => [ns, new Set(Object.keys(v))]),
)

// Color utilities that take a <color> argument. Order matters: longer prefixes
// (border-x) are tried before shorter (border) so `border-x-surface-2` parses.
const COLOR_UTILS = [
  'bg', 'text', 'decoration', 'placeholder', 'caret', 'fill', 'stroke',
  'ring-offset', 'ring', 'outline', 'divide', 'from', 'via', 'to',
  'border-x', 'border-y', 'border-s', 'border-e',
  'border-t', 'border-r', 'border-b', 'border-l', 'border',
]

// Color-name words borrowed from shadcn/Radix conventions that people type
// reflexively but were never defined here. Reported wherever they appear as the
// color argument of a color utility (e.g. `border-border`, `bg-muted`).
const UNKNOWN_COLOR_WORDS = new Set([
  'border', 'foreground', 'background', 'muted', 'card', 'popover',
  'input', 'destructive', 'secondary', 'ring',
])

/** Strip variants (`hover:`, `md:`, `[&>svg]:`), leading `!`, and `/opacity`. */
function normalize(token) {
  const last = token.split(':').pop() ?? token
  return last.replace(/^!/, '').split('/')[0]
}

/** @returns {string | null} an error message, or null if the token is fine. */
function checkToken(raw) {
  const token = normalize(raw)
  for (const util of COLOR_UTILS) {
    if (!token.startsWith(util + '-')) continue
    const rest = token.slice(util.length + 1) // after "util-"
    const [color, sub] = rest.split('-')

    if (NAMESPACES.has(color)) {
      const keys = NAMESPACES.get(color)
      // bare `bg-primary` resolves to DEFAULT; `bg-surface` has no DEFAULT.
      const key = sub ?? 'DEFAULT'
      if (!keys.has(key)) {
        return `"${normalize(raw)}" uses an unknown ${color} shade. Valid: ${[...keys].map((k) => (k === 'DEFAULT' ? color : `${color}-${k}`)).join(', ')}.`
      }
      return null
    }
    if (UNKNOWN_COLOR_WORDS.has(color)) {
      return `"${normalize(raw)}" references color "${color}", which isn't defined in tailwind.theme.js. Use a defined color (e.g. surface-*, primary, accent-*) or a standard Tailwind color.`
    }
    return null // recognized util, non-custom color (slate-300, white, etc.)
  }
  return null
}

function scanString(value, node, context) {
  if (!value || !value.includes('-')) return
  for (const tok of value.split(/\s+/)) {
    if (!tok) continue
    const msg = checkToken(tok)
    if (msg) context.report({ node, message: msg })
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export const validThemeClassnames = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Tailwind utilities that reference undefined custom-palette colors (they emit no CSS and render invisibly).',
    },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === 'string') scanString(node.value, node, context)
      },
      TemplateElement(node) {
        scanString(node.value.cooked ?? node.value.raw, node, context)
      },
    }
  },
}
