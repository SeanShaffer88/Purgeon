import { dispatchFeature } from '../runtime.js';
export const create = (arg) => dispatchFeature('restore:create', arg);
