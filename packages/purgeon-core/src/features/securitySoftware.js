import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('securitySoftware:list', arg);
export const prepare = (arg) => dispatchFeature('securitySoftware:prepare', arg);
export const launch = (arg) => dispatchFeature('securitySoftware:launch', arg);
export const cancel = (arg) => dispatchFeature('securitySoftware:cancel', arg);
export const status = (arg) => dispatchFeature('securitySoftware:status', arg);
export const acknowledge = (arg) => dispatchFeature('securitySoftware:acknowledge', arg);
