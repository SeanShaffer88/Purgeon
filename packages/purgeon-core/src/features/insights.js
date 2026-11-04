import { dispatchFeature } from '../runtime.js';
export const insights = (arg) => dispatchFeature('programs:insights', arg);
export const recordSizes = (arg) => dispatchFeature('programs:recordSizes', arg);
export const sizeHistory = (arg) => dispatchFeature('programs:sizeHistory', arg);
export const signatures = (arg) => dispatchFeature('files:signatures', arg);
export const verifySignature = (arg) => dispatchFeature('security:verifySignature', arg);
