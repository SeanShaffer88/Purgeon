import { dispatchFeature } from '../runtime.js';
export const status = (arg) => dispatchFeature('dns:status', arg);
export const apply = (arg) => dispatchFeature('dns:apply', arg);
export const setNagle = (arg) => dispatchFeature('dns:setNagle', arg);
export const reset = (arg) => dispatchFeature('dns:reset', arg);
