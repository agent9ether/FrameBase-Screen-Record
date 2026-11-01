const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  eqeqeq: ['error', 'always'],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error'
};

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'release/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules
  },
  {
    // sandboxed preloads: only electron and a few Node globals are available
    files: ['preload.js', 'control-preload.js'],
    languageOptions: { globals: { ...globals.browser, process: 'readonly' } }
  },
  {
    // page scripts share one global scope: renderer.js defines $, $$ and startCapture for agent-ui.js
    files: ['renderer.js', 'agent-ui.js', 'mini-control.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^(startCapture)$' }] }
  },
  {
    // edit-timing.js runs in the studio (as window.editTiming) and in Node for the unit tests
    files: ['edit-timing.js'],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ['renderer.js'],
    languageOptions: { globals: { editTiming: 'readonly' } }
  },
  {
    files: ['agent-ui.js'],
    languageOptions: { globals: { $: 'readonly', $$: 'readonly', startCapture: 'readonly' } }
  },
  {
    files: ['test/e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node } }
  }
];
