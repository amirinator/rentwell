/**
 * Design tokens.
 *
 * The palette is deliberately narrow and low-saturation. This is a screen
 * people read numbers off for hours; colour is used to carry meaning — a
 * blocker, a reversal, an amount that does not balance — and nowhere else.
 *
 * Status colours are chosen so that each is distinguishable in greyscale and
 * for the common forms of colour blindness, and every status in the UI is also
 * labelled in words, so colour is never the only signal.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f6f7f9',
          100: '#eceef2',
          200: '#d5dae2',
          300: '#b0bac9',
          400: '#8695ab',
          500: '#677790',
          600: '#526078',
          700: '#434e62',
          800: '#3a4353',
          900: '#343b47',
          950: '#23272f',
        },
        accent: {
          50: '#eef6ff',
          100: '#d9ebff',
          200: '#bcdcff',
          300: '#8ec6ff',
          400: '#59a6ff',
          500: '#3383fb',
          600: '#1d64f0',
          700: '#164fdc',
          800: '#1841b2',
          900: '#1a3b8c',
        },
        positive: { 100: '#dcf5e7', 600: '#128a52', 800: '#0b5c37' },
        caution: { 100: '#fdf0d5', 600: '#9a6700', 800: '#6b4800' },
        critical: { 100: '#fde3e1', 600: '#c0392f', 800: '#8a2721' },
      },
      fontFamily: {
        sans: [
          'Inter var',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        // Tabular figures matter: a column of amounts must align on the decimal
        // point, or scanning it for an outlier stops working.
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(35, 39, 47, 0.06), 0 1px 3px rgba(35, 39, 47, 0.04)',
      },
    },
  },
  plugins: [],
};
