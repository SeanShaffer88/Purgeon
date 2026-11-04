import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('ctxmenu:list', arg);
export const set = (arg) => dispatchFeature('ctxmenu:set', arg);
