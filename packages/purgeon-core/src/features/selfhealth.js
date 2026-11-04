import { dispatchFeature } from '../runtime.js';
export const check = (arg) => dispatchFeature('selfhealth:check', arg);
