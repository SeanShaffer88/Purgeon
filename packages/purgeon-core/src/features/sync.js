import { dispatchFeature } from '../runtime.js';
export const status = (arg) => dispatchFeature('sync:status', arg);
export const apply = (arg) => dispatchFeature('sync:apply', arg);
export const syncNow = (arg) => dispatchFeature('sync:syncNow', arg);
