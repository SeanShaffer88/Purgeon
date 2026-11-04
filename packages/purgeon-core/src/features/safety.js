import { dispatchFeature } from '../runtime.js';
export const dependencies = (arg) => dispatchFeature('safety:dependencies', arg);
export const classify = (arg) => dispatchFeature('safety:classify', arg);
