import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('browsers:list', arg);
export const running = (arg) => dispatchFeature('browsers:running', arg);
