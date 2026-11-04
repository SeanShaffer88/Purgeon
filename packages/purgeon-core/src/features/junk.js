import { dispatchFeature } from '../runtime.js';
export const scan = (arg) => dispatchFeature('junk:scan', arg);
export const scanCancel = (arg) => dispatchFeature('junk:scanCancel', arg);
export const scanSystem = (arg) => dispatchFeature('junk:scanSystem', arg);
export const cleanSystem = (arg) => dispatchFeature('junk:cleanSystem', arg);
export const cleanSystemCancel = (arg) => dispatchFeature('junk:cleanSystemCancel', arg);
