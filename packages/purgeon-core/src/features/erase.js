import { dispatchFeature } from '../runtime.js';
export const pick = (arg) => dispatchFeature('erase:pick', arg);
export const collect = (arg) => dispatchFeature('erase:collect', arg);
export const run = (arg) => dispatchFeature('erase:run', arg);
export const runCancel = (arg) => dispatchFeature('erase:runCancel', arg);
