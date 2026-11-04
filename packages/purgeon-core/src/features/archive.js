import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('archive:list', arg);
export const add = (arg) => dispatchFeature('archive:add', arg);
export const attachBackup = (arg) => dispatchFeature('archive:attachBackup', arg);
export const setPackage = (arg) => dispatchFeature('archive:setPackage', arg);
export const remove = (arg) => dispatchFeature('archive:remove', arg);
