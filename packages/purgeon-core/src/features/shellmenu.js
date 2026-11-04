import { dispatchFeature } from '../runtime.js';
export const enabled = (arg) => dispatchFeature('shell:enabled', arg);
export const enable = (arg) => dispatchFeature('shell:enable', arg);
export const disable = (arg) => dispatchFeature('shell:disable', arg);
export const resolve = (arg) => dispatchFeature('shell:resolve', arg);
