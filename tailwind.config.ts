import type { Config } from 'tailwindcss'
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#00f0ff',
          dim: '#00a5b0',
          glow: 'rgba(0, 240, 255, 0.15)',
        },
        surface: {
          base: '#06080a',
          panel: '#0a0e12',
          raised: '#0f1419',
          hover: '#141c24',
        },
        accent: {
          red: '#ff3366',
          green: '#00ff88',
          amber: '#ffaa00',
        },
      },
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
        // --- Hotkey activation flourish ---
        'ignite': {
          '0%':   { borderColor: 'var(--ignite-base, #1e3a5f)', boxShadow: 'none', transform: 'scale(1)' },
          '8%':   { borderColor: '#00f0ff', boxShadow: '0 0 0 6px rgba(0,240,255,0.4), 0 0 30px rgba(0,240,255,0.3), inset 0 0 30px rgba(0,240,255,0.15)', transform: 'scale(1.02)' },
          '25%':  { borderColor: '#00f0ff', boxShadow: '0 0 0 3px rgba(0,240,255,0.2), inset 0 0 15px rgba(0,240,255,0.08)', transform: 'scale(1.01)' },
          '100%': { borderColor: 'var(--ignite-base, #1e3a5f)', boxShadow: 'none', transform: 'scale(1)' },
        },
        'scan-oneshot': {
          '0%':   { transform: 'translateX(-100%) skewX(-10deg)', opacity: '0' },
          '5%':   { opacity: '0.9' },
          '100%': { transform: 'translateX(120%) skewX(-10deg)', opacity: '0' },
        },
        'ripple-ring': {
          '0%':   { inset: '0px', borderColor: 'rgba(0,240,255,0.8)', opacity: '1' },
          '100%': { inset: '-20px', borderColor: 'rgba(0,240,255,0)', opacity: '0' },
        },
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'scan': 'scan 8s linear infinite',
        'shimmer': 'shimmer 1.5s ease-in-out infinite',
        'ignite': 'ignite 500ms cubic-bezier(0.22, 1, 0.36, 1) forwards',
        'scan-oneshot': 'scan-oneshot 350ms 20ms ease forwards',
        'ripple-ring': 'ripple-ring 500ms 20ms cubic-bezier(0.2, 0, 0.6, 1) forwards',
      },
    },
  },
  plugins: [],
} satisfies Config
