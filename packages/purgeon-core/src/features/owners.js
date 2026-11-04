import { dispatchFeature } from '../runtime.js';
export const who = (arg) => dispatchFeature('owners:who', arg);
export const pick = (arg) => dispatchFeature('owners:pick', arg);
export const scan = (arg) => dispatchFeature('orphans:scan', arg);
export const scanCancel = (arg) => dispatchFeature('orphans:scanCancel', arg);
