import { dispatchFeature } from '../runtime.js';
export const status = (arg) => dispatchFeature('maintenance:status', arg);
export const apply = (arg) => dispatchFeature('maintenance:apply', arg);
export const runNow = (arg) => dispatchFeature('maintenance:runNow', arg);
