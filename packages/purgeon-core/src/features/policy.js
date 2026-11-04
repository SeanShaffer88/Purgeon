import { dispatchFeature } from '../runtime.js';
export const get = (arg) => dispatchFeature('policy:get', arg);
