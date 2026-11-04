import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('plugins:list', arg);
export const setEnabled = (arg) => dispatchFeature('plugins:setEnabled', arg);
export const runLeftoverRules = (arg) => dispatchFeature('plugins:runLeftoverRules', arg);
export const validate = (arg) => dispatchFeature('plugins:validate', arg);
