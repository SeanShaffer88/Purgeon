import { dispatchFeature } from '../runtime.js';
export const languages = (arg) => dispatchFeature('i18n:languages', arg);
export const current = (arg) => dispatchFeature('i18n:current', arg);
export const set = (arg) => dispatchFeature('i18n:set', arg);
