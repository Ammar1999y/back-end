import type { Config } from 'tailwindcss';

import animate from 'tailwindcss-animate';
import plugin from 'tailwindcss/plugin';

import { breakpointsTokens } from './utils/breakpoints';

// Generate spacing values using CSS calc with --spacing variable
// This mimics Tailwind v4's dynamic spacing behavior
const generateSpacing = () => {
  const spacing: Record<string, string> = {
    px: '1px',
    0: '0px',
    0.5: 'calc(var(--spacing) * 0.5)',
    1: 'calc(var(--spacing) * 1)',
    1.5: 'calc(var(--spacing) * 1.5)',
    2: 'calc(var(--spacing) * 2)',
    2.5: 'calc(var(--spacing) * 2.5)',
    3: 'calc(var(--spacing) * 3)',
    3.5: 'calc(var(--spacing) * 3.5)',
    4: 'calc(var(--spacing) * 4)',
    5: 'calc(var(--spacing) * 5)',
    6: 'calc(var(--spacing) * 6)',
    7: 'calc(var(--spacing) * 7)',
    8: 'calc(var(--spacing) * 8)',
    9: 'calc(var(--spacing) * 9)',
    10: 'calc(var(--spacing) * 10)',
    11: 'calc(var(--spacing) * 11)',
    12: 'calc(var(--spacing) * 12)',
    14: 'calc(var(--spacing) * 14)',
    16: 'calc(var(--spacing) * 16)',
    20: 'calc(var(--spacing) * 20)',
    24: 'calc(var(--spacing) * 24)',
    28: 'calc(var(--spacing) * 28)',
    32: 'calc(var(--spacing) * 32)',
    36: 'calc(var(--spacing) * 36)',
    40: 'calc(var(--spacing) * 40)',
    44: 'calc(var(--spacing) * 44)',
    48: 'calc(var(--spacing) * 48)',
    52: 'calc(var(--spacing) * 52)',
    56: 'calc(var(--spacing) * 56)',
    60: 'calc(var(--spacing) * 60)',
    64: 'calc(var(--spacing) * 64)',
    72: 'calc(var(--spacing) * 72)',
    80: 'calc(var(--spacing) * 80)',
    96: 'calc(var(--spacing) * 96)',
  };
  return spacing;
};

const config: Config = {
  darkMode: ['class', `[data-theme='dark']`],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    borderRadius: {
      xs: 'calc(var(--radius) - 6px)',
      sm: 'calc(var(--radius) - 4px)',
      md: 'calc(var(--radius) - 2px)',
      lg: 'var(--radius)',
      xl: 'calc(var(--radius) + 4px)',
      '2xl': 'calc(var(--radius) + 8px)',
      '3xl': 'calc(var(--radius) + 14px)',
      DEFAULT: 'var(--radius)',
      full: '9999px',
      none: '0',
    },
    extend: {
      screens: {
        ...breakpointsTokens,
      },
      fontFamily: {
        main: ['var(--font-family)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        xs: ['var(--text-xs)', 'var(--text-xs-line-height)'],
        sm: ['var(--text-sm)', 'var(--text-sm-line-height)'],
        base: ['var(--text-base)', 'var(--text-base-line-height)'],
        lg: ['var(--text-lg)', 'var(--text-lg-line-height)'],
        xl: ['var(--text-xl)', 'var(--text-xl-line-height)'],
        '2xl': ['var(--text-2xl)', 'var(--text-2xl-line-height)'],
        '3xl': ['var(--text-3xl)', 'var(--text-3xl-line-height)'],
        '4xl': ['var(--text-4xl)', 'var(--text-4xl--line-height)'],
        '5xl': ['var(--text-5xl)', 'var(--text-5xl--line-height)'],
      },
      colors: {
        gray: {
          100: 'hsl(var(--gray-100))',
          200: 'hsl(var(--gray-200))',
          300: 'hsl(var(--gray-300))',
          400: 'hsl(var(--gray-400))',
          500: 'hsl(var(--gray-500))',
          600: 'hsl(var(--gray-600))',
          700: 'hsl(var(--gray-700))',
          800: 'hsl(var(--gray-800))',
          900: 'hsl(var(--gray-900))',
        },
        success: {
          DEFAULT: 'hsl(var(--colors-palette-success-default))',
          dark: 'hsl(var(--colors-palette-success-dark))',
        },
        warning: {
          DEFAULT: 'hsl(var(--colors-palette-warning-default))',
          dark: 'hsl(var(--colors-palette-warning-dark))',
        },
        error: {
          DEFAULT: 'hsl(var(--colors-palette-error-default))',
          dark: 'hsl(var(--colors-palette-error-dark))',
        },
        info: {
          DEFAULT: 'hsl(var(--colors-palette-info-default))',
          dark: 'hsl(var(--colors-palette-info-dark))',
        },
        background: 'hsl(var(--background))',
        foreground: {
          DEFAULT: 'hsl(var(--foreground))',
          dark: 'hsl(var(--foreground-dark))',
          light: 'hsl(var(--foreground-light))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
          placeholder: 'hsl(var(--placeholder))',
        },
        highlight: 'hsl(var(--highlight))',
      },
      spacing: {
        ...generateSpacing(),
        input: 'calc(var(--spacing) * 10)',
      },
      zIndex: {
        'app-bar': 'var(--zIndex-appBar)',
        nav: 'var(--zIndex-nav)',
        scrollbar: 'var(--zIndex-scrollbar)',
      },
      boxShadow: {
        '2xs': 'var(--shadow-2xs)',
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        '2xl': 'var(--shadow-2xl)',
      },
      letterSpacing: {
        tighter: 'calc(var(--tracking-normal) - 0.05em)',
        tight: 'calc(var(--tracking-normal) - 0.025em)',
        normal: 'var(--tracking-normal)',
        wide: 'calc(var(--tracking-normal) + 0.025em)',
        wider: 'calc(var(--tracking-normal) + 0.05em)',
        widest: 'calc(var(--tracking-normal) + 0.1em)',
      },
      opacity: {
        hover: '0.1',
        focus: '0.2',
      },
      keyframes: {
        'spin-pulse': {
          '0%': { transform: 'rotate(0deg) scale(0.9)' },
          '50%': { transform: 'rotate(180deg) scale(1.1)' },
          '100%': { transform: 'rotate(360deg) scale(0.9)' },
        },
        'collapsible-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-collapsible-content-height)' },
        },
        'collapsible-up': {
          from: { height: 'var(--radix-collapsible-content-height)' },
          to: { height: '0' },
        },
        spin: {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'fade-in': {
          '0%': {
            opacity: '0',
            transform: 'translateY(10px)',
          },
          '100%': {
            opacity: '1',
            transform: 'translateY(0)',
          },
        },

        'accordion-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-accordion-content-height)',
          },
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)',
          },
          to: {
            height: '0',
          },
        },
        'dnd-pop': {
          '0%': {
            transform: 'translate3d(0px, 0px, 0) scale(1)',
          },
          '100%': {
            transform: 'translate3d(10px, 10px, 0) scale(1.025)',
          },
        },
      },
      animation: {
        'spin-pulse': 'spin-pulse 1s linear infinite',
        'collapsible-down': 'collapsible-down 0.2s ease-in-out',
        'collapsible-up': 'collapsible-up 0.2s ease-in-out',
        'slow-spin': 'spin 10s linear infinite',
        'fade-in': 'fade-in 0.3s ease-out',
        'fade-in-table': 'fade-in 0.5s ease-out',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'dnd-pop': 'dnd-pop 150ms cubic-bezier(0.18, 0.67, 0.6, 1.22)',
      },
    },
  },
  corePlugins: {
    container: false,
    space: false,
  },
  plugins: [
    plugin(function ({ addVariant }) {
      addVariant('touch', '@media (hover: none)');
      addVariant('hover-device', '@media (hover: hover)');
    }),
    plugin(function ({ matchUtilities, theme }) {
      matchUtilities(
        {
          'space-x': (value) => ({
            '& > :not([hidden]) ~ :not([hidden]):not([data-ignore])': {
              'margin-inline-start': value,
            },
          }),
        },
        { values: theme('spacing') }
      );
      matchUtilities(
        {
          'space-x-e': (value) => ({
            '& > *:not(:last-child)': {
              'margin-inline-end': value,
            },
          }),
        },
        { values: theme('spacing') }
      );
      matchUtilities(
        {
          'space-y': (value) => ({
            '& > :not([hidden]) ~ :not([hidden]):not([data-ignore])': {
              'margin-top': value,
            },
          }),
        },
        { values: theme('spacing') }
      );
      matchUtilities(
        {
          dh: (value) => ({
            height: `${value}vh`,
            '@supports (height: 1dvh)': {
              height: `${value}dvh`,
            },
          }),
        },
        {
          values: Object.fromEntries(
            Array.from({ length: 101 }, (_, i) => [i, i])
          ) as Record<number, number>,
        }
      );
    }),
    animate,
  ],
};
export default config;
