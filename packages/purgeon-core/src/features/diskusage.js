import { dispatchFeature } from '../runtime.js';
export const drives = (arg) => dispatchFeature('disk:drives', arg);
export const scan = (arg) => dispatchFeature('disk:scan', arg);
export const scanCancel = (arg) => dispatchFeature('disk:scanCancel', arg);
export const list = (arg) => dispatchFeature('disk:list', arg);
export const measure = (arg) => dispatchFeature('disk:measure', arg);
export const measureCancel = (arg) => dispatchFeature('disk:measureCancel', arg);
export const open = (arg) => dispatchFeature('disk:open', arg);
