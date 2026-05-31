// Makes @testing-library/jest-dom's matcher type augmentation (toBeInTheDocument,
// toHaveAttribute, …) visible to `tsc -p tsconfig.app.json`. The matchers are
// registered at runtime by tests/setup.ts, but that file lives outside this
// project's `include: ["src"]`, so the `declare module 'vitest'` augmentation it
// pulls in was never seen by the type checker. This ambient (type-only) import
// inside src fixes that. Not emitted — .d.ts files produce no JS.
import '@testing-library/jest-dom/vitest'
