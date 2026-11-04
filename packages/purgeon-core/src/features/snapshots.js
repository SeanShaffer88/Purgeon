import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('snapshots:list', arg);
export const take = (arg) => dispatchFeature('snapshots:take', arg);
export const remove = (arg) => dispatchFeature('snapshots:remove', arg);
export const rename = (arg) => dispatchFeature('snapshots:rename', arg);
export const compare = (arg) => dispatchFeature('snapshots:compare', arg);
export const cancel = (arg) => dispatchFeature('snapshots:cancel', arg);
export const cleanupItems = (arg) => dispatchFeature('snapshots:cleanupItems', arg);
