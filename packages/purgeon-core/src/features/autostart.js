import { dispatchFeature } from '../runtime.js';
export const enabled = (arg) => dispatchFeature('autostart:enabled', arg);
export const set = (arg) => dispatchFeature('autostart:set', arg);
