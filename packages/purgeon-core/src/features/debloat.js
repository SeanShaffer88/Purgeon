import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('debloat:list', arg);
export const previousDamaged = (arg) => dispatchFeature('debloat:previousDamaged', arg);
export const recover = (arg) => dispatchFeature('debloat:recover', arg);
export const set = (arg) => dispatchFeature('debloat:set', arg);
export const restartExplorer = (arg) => dispatchFeature('debloat:restartExplorer', arg);
