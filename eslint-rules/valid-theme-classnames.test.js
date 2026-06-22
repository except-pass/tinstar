import { RuleTester } from 'eslint'
import { validThemeClassnames } from './valid-theme-classnames.js'

// Vitest provides describe/it globally (globals: true); RuleTester picks them up.
const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
})

ruleTester.run('valid-theme-classnames', validThemeClassnames, {
  valid: [
    // Bare custom namespaces with a valid key / DEFAULT.
    { code: 'const c = "bg-primary text-primary-dim accent-red"' },
    { code: 'const c = "bg-surface-base border-surface-hover"' },
    { code: 'const c = "border-l-surface-raised"' }, // longest-prefix util
    { code: 'const c = "bg-primary/15 outline-primary/60"' }, // opacity modifier
    { code: 'const c = "hover:text-white md:bg-surface-panel"' }, // variants
    // Standard Tailwind colors + non-color utilities pass through untouched.
    { code: 'const c = "text-slate-300 bg-blue-500 border-2 border-collapse"' },
    { code: 'const c = "text-sm flex gap-1 material-symbols-outlined"' },
    // Template-literal quasi cut off at an interpolation boundary — the shade is
    // dynamic, so the trailing-hyphen fragment must NOT be flagged.
    { code: 'const s = "x"; const c = `bg-surface-${s}`' },
    { code: 'const s = "x"; const c = `text-${s}`' },
  ],
  invalid: [
    {
      code: 'const c = "bg-surface-2"', // undefined surface shade
      errors: [{ message: /unknown surface shade/ }],
    },
    {
      code: 'const c = "border-border"', // shadcn-ism, no such color here
      errors: [{ message: /isn't defined in tailwind\.theme\.js/ }],
    },
    {
      code: 'const c = "bg-muted"',
      errors: [{ message: /isn't defined in tailwind\.theme\.js/ }],
    },
    {
      code: 'const c = "bg-surface"', // bare surface has no DEFAULT
      errors: [{ message: /unknown surface shade/ }],
    },
    {
      code: 'const c = "text-primary-bright"', // the real bug this rule caught
      errors: [{ message: /unknown primary shade/ }],
    },
  ],
})
