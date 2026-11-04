import { dispatchFeature } from '../runtime.js';
export const find = (arg) => dispatchFeature('portable:find', arg);
export const addFolder = (arg) => dispatchFeature('portable:addFolder', arg);
export const removeFolder = (arg) => dispatchFeature('portable:removeFolder', arg);
export const checkUpdates = (arg) => dispatchFeature('portable:checkUpdates', arg);
export const register = (arg) => dispatchFeature('portable:register', arg);
export const unregister = (arg) => dispatchFeature('portable:unregister', arg);
