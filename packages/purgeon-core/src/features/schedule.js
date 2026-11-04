import { dispatchFeature } from '../runtime.js';
export const status = (arg) => dispatchFeature('schedule:status', arg);
export const apply = (arg) => dispatchFeature('schedule:apply', arg);
export const backgroundScan = (arg) => dispatchFeature('schedule:backgroundScan', arg);
export const markMissed = (arg) => dispatchFeature('schedule:markMissed', arg);
