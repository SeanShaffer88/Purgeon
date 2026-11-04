import { dispatchFeature } from '../runtime.js';
export const rules = (arg) => dispatchFeature('cookies:rules', arg);
export const addRule = (arg) => dispatchFeature('cookies:addRule', arg);
export const removeRule = (arg) => dispatchFeature('cookies:removeRule', arg);
