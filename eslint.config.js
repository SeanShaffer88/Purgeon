import globals from 'globals';
export default [{ ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'audit-probes.mjs'] }, {
  files: ['src/**/*.{js,jsx}'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } }, globals: { ...globals.browser, __APP_VERSION__: 'readonly' } },
  rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'valid-typeof': 'error', 'constructor-super': 'error', 'no-constant-binary-expression': 'error' },
}];
