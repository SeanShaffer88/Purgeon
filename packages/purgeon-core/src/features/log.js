import { dispatchFeature } from '../runtime.js';
export const open = (arg) => dispatchFeature('log:open', arg);
export const flush = (arg) => dispatchFeature('log:flush', arg);
