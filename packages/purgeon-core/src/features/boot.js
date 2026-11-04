import { dispatchFeature } from '../runtime.js';
export const state = (arg) => dispatchFeature('boot:state', arg);
export const setSafeBoot = (arg) => dispatchFeature('boot:setSafeBoot', arg);
export const setTimeout = (arg) => dispatchFeature('boot:setTimeout', arg);
export const undo = (arg) => dispatchFeature('boot:undo', arg);
