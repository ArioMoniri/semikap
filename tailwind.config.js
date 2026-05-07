import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        tamias: {
          ink: '#0b1d3a',
          accent: '#1d4ed8',
          mask: '#22c55e',
        },
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-collapsible-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-collapsible-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 180ms ease-out',
        'accordion-up': 'accordion-up 180ms ease-out',
      },
    },
  },
  plugins: [animate],
};
