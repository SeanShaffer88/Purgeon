import { dispatchFeature } from '../runtime.js';
export const state = (arg) => dispatchFeature('restore:state', arg);
export const setProtection = (arg) => dispatchFeature('restore:setProtection', arg);
export const setMax = (arg) => dispatchFeature('restore:setMax', arg);
export const removePoint = (arg) => dispatchFeature('restore:removePoint', arg);
export const createPoint = (arg) => dispatchFeature('restore:createPoint', arg);
export const openUi = (arg) => dispatchFeature('restore:openUi', arg);
