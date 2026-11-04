import { dispatchFeature } from '../runtime.js';
export const get = (arg) => dispatchFeature('settings:get', arg);
export const set = (arg) => dispatchFeature('settings:set', arg);
