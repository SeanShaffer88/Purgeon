import { dispatchFeature } from '../runtime.js';
export const create = (arg) => dispatchFeature('restorepoint:create', arg);
export const list = (arg) => dispatchFeature('restorepoint:list', arg);
