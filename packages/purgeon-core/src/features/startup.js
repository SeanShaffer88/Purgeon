import { dispatchFeature } from '../runtime.js';
export const trust = (arg) => dispatchFeature('startup:trust', arg);
export const newEntries = (arg) => dispatchFeature('startup:newEntries', arg);
export const accept = (arg) => dispatchFeature('startup:accept', arg);
export const list = (arg) => dispatchFeature('startup:list', arg);
export const set = (arg) => dispatchFeature('startup:set', arg);
export const delayed = (arg) => dispatchFeature('startup:delayed', arg);
