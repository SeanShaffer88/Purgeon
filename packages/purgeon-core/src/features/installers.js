import { dispatchFeature } from '../runtime.js';
export const describe = (arg) => dispatchFeature('installers:describe', arg);
export const items = (arg) => dispatchFeature('installers:items', arg);
