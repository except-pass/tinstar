import type { Config } from 'tailwindcss'
// Custom palette lives in a shared module so the ESLint className linter reads
// the exact same keys — see eslint-rules/valid-theme-classnames.js.
import { colors } from './tailwind.theme.js'
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors,
      fontFamily: {
        display: ['"Chakra Petch"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      borderRadius: {
        DEFAULT: '2px',
        sm: '1px',
      },
      boxShadow: {
        neon: '0 0 8px rgba(0, 240, 255, 0.25), 0 0 2px rgba(0, 240, 255, 0.5)',
        'neon-strong': '0 0 12px rgba(0, 240, 255, 0.4), 0 0 4px rgba(0, 240, 255, 0.7)',
        'neon-inner': 'inset 0 0 12px rgba(0, 240, 255, 0.08)',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'scan': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        'shimmer': {
          '0%': { opacity: '0.3' },
          '50%': { opacity: '0.8' },
          '100%': { opacity: '0.3' },
        },
        // ignite / scan-oneshot / ripple-ring are defined in index.css directly
        // so they are always bundled (Tailwind purges unused keyframes).
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'scan': 'scan 8s linear infinite',
        'shimmer': 'shimmer 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
