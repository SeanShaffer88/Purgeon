import { dispatchFeature } from '../runtime.js';
export const scan = (arg) => dispatchFeature('deepscan:scan', arg);
