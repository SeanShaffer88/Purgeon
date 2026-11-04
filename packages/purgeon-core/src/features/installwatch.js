import { dispatchFeature } from '../runtime.js';
export const check = (arg) => dispatchFeature('installers:check', arg);
