import { dispatchFeature } from '../runtime.js';
export const pick = (arg) => dispatchFeature('duplicates:pick', arg);
export const scan = (arg) => dispatchFeature('duplicates:scan', arg);
export const scanCancel = (arg) => dispatchFeature('duplicates:scanCancel', arg);
export const remove = (arg) => dispatchFeature('duplicates:remove', arg);
