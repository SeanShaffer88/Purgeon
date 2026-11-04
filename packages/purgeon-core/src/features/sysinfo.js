import { dispatchFeature } from '../runtime.js';
export const sysinfo = (arg) => dispatchFeature('app:sysinfo', arg);
