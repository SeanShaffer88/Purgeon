import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('tasks:list', arg);
export const setEnabled = (arg) => dispatchFeature('tasks:setEnabled', arg);
export const runNow = (arg) => dispatchFeature('tasks:runNow', arg);
export const stop = (arg) => dispatchFeature('tasks:stop', arg);
export const remove = (arg) => dispatchFeature('tasks:remove', arg);
export const restore = (arg) => dispatchFeature('tasks:restore', arg);
export const create = (arg) => dispatchFeature('tasks:create', arg);
export const pickProgram = (arg) => dispatchFeature('tasks:pickProgram', arg);
