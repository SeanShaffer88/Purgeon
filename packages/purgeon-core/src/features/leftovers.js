import { dispatchFeature } from '../runtime.js';
export const scan = (arg) => dispatchFeature('program:scan', arg);
export const remove = (arg) => dispatchFeature('items:remove', arg);
export const removeCancel = (arg) => dispatchFeature('items:removeCancel', arg);
