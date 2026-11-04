import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('trials:list', arg);
export const start = (arg) => dispatchFeature('trials:start', arg);
export const launch = (arg) => dispatchFeature('trials:launch', arg);
export const tryOver = (arg) => dispatchFeature('trials:tryOver', arg);
export const finish = (arg) => dispatchFeature('trials:finish', arg);
