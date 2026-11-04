import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('history:list', arg);
export const undo = (arg) => dispatchFeature('history:undo', arg);
