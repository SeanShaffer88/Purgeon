import { dispatchFeature } from '../runtime.js';
export const settings = (arg) => dispatchFeature('update:settings', arg);
export const enable = (arg) => dispatchFeature('update:enable', arg);
export const check = (arg) => dispatchFeature('update:check', arg);
export const install = (arg) => dispatchFeature('update:install', arg);
