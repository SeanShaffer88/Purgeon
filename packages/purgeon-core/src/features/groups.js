import { dispatchFeature } from '../runtime.js';
export const get = (arg) => dispatchFeature('groups:get', arg);
export const set = (arg) => dispatchFeature('groups:set', arg);
export const restore = (arg) => dispatchFeature('groups:restore', arg);
