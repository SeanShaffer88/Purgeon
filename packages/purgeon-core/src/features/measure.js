import { dispatchFeature } from '../runtime.js';
export { subscribeMeasured as onMeasured } from '../runtime.js';
export const measure = (arg) => dispatchFeature('programs:measure', arg);
export const measureCancel = (arg) => dispatchFeature('programs:measureCancel', arg);
export const measureStore = (arg) => dispatchFeature('programs:measureStore', arg);
