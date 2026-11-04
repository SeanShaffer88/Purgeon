import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('games:list', arg);
export const listCancel = (arg) => dispatchFeature('games:listCancel', arg);
export const cleanup = (arg) => dispatchFeature('games:cleanup', arg);
