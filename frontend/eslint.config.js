import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'dist/',
      '.agents/skills/shadcn/',
      'playwright-report/',
      'test-results/',
      'src/app/router/routeTree.gen.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{js,mjs,cjs,jsx,ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['*.{js,mjs,cjs,ts}', 'scripts/**/*.{js,mjs,cjs,ts}', 'src/**/*.e2e.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    ...reactHooks.configs.flat.recommended,
    files: ['src/**/*.{js,jsx,ts,tsx}'],
  },
  {
    ...reactRefresh.configs.vite,
    files: ['src/**/*.{jsx,tsx}'],
  },
  {
    // TanStack route modules must export route definitions, and shadcn primitives export styles.
    files: ['src/app/routes/**/*.tsx', 'src/shared/ui/{badge,button}.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // The controlled calendar derives "today" at render time to preserve its date-selection behavior.
    files: ['src/pages/backtest/ui/DateRangePicker.tsx'],
    rules: {
      'react-hooks/purity': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    rules: {
      // Existing callback and object-rest code names intentionally discarded values with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
