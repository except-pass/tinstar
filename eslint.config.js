// Tinstar ESLint config — minimal, scoped to the className rule.

import tsParser from '@typescript-eslint/parser'
import { validThemeClassnames } from './eslint-rules/valid-theme-classnames.js'

// Stub plugin so inline `eslint-disable react-hooks/...` directives in the
// source files don't error out — we don't run the react-hooks rules here.
// ESLint requires referenced rules to be defined; an off-by-default no-op rule
// satisfies that without enforcing it.
const reactHooksStub = {
  rules: {
    'exhaustive-deps': { create: () => ({}), meta: { schema: [] } },
    'rules-of-hooks': { create: () => ({}), meta: { schema: [] } },
  },
}

export default [
  {
    // Global ignores — build output, native bundles, deps. (A config object with
    // only `ignores` sets ignores for the whole run.)
    ignores: ['dist/**', 'dist-*/**', 'src-tauri/target/**', 'node_modules/**'],
  },
  {
    // Catch className typos that target the custom palette but emit no CSS
    // (e.g. `bg-surface-2`, `border-border`) — they render invisibly.
    files: ['src/**/*.{ts,tsx}'],
    // Files carry inline `eslint-disable react-hooks/...` and `no-console`
    // directives. We don't run those rules, so: register the react-hooks stub and
    // silence unused-directive noise — this block enforces only the className rule.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      tinstar: { rules: { 'valid-theme-classnames': validThemeClassnames } },
      'react-hooks': reactHooksStub,
    },
    rules: {
      'tinstar/valid-theme-classnames': 'error',
    },
  },
]
