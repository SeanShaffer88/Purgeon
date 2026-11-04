import { resolveLanguage as resolve } from '../../packages/purgeon-core/src/internal/i18n.js';
export * from '../../packages/purgeon-core/src/internal/i18n.js';
export async function resolveLanguage() {
  const language = await resolve();
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  return language;
}
