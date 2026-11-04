import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('drivers:list', arg);
export const candidates = (arg) => dispatchFeature('drivers:candidates', arg);
export const recover = (arg) => dispatchFeature('drivers:recover', arg);
export const recovery = (arg) => dispatchFeature('drivers:recovery', arg);
export const removeDriver = (arg) => dispatchFeature('drivers:delete', arg);
