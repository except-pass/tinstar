// Tinstar ESLint config — minimal, scoped to enforcing architectural boundaries.
//
// Built-in plugins under `src/plugins/<name>/src/**` must consume only
// `@tinstar/plugin-api`. Runtime imports from host modules are forbidden.
// Documented exceptions (intentionally NOT in the forbidden patterns below):
//   - `import type` from `src/domain/types` (allowed in all plugins)
//   - `import { EV }` from `src/lib/windowEvents` (shared window-events schema)
// See docs/adrs/0002-plugin-api-boundary.md.

import tsParser from '@typescript-eslint/parser'

// Stub plugin so inline `eslint-disable react-hooks/...` directives in the
// plugin source files don't error out — we don't run the react-hooks rules
// here, only the boundary rule. ESLint requires referenced rules to be
// defined; an off-by-default no-op rule satisfies that without enforcing it.
const reactHooksStub = {
  rules: {
    'exhaustive-deps': { create: () => ({}), meta: { schema: [] } },
    'rules-of-hooks': { create: () => ({}), meta: { schema: [] } },
  },
}

export default [
  {
    files: ['src/plugins/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooksStub,
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/components/**',
                '**/hooks/**',
                '**/hotkeys/**',
                '**/widgets/**',
                '**/apiClient',
              ],
              message:
                'Plugins must not import host modules at runtime. Use the api.* surface from @tinstar/plugin-api. See docs/adrs/0002-plugin-api-boundary.md.',
            },
            {
              group: ['**/lib/uiPrefs', '**/lib/userPrefs'],
              message:
                'Plugins must not read host UI prefs directly. Use the api.* surface.',
            },
          ],
        },
      ],
    },
  },
]
