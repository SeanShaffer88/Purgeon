import { dispatchFeature } from '../runtime.js';
export const list = (arg) => dispatchFeature('trusted:list', arg);
export const add = (arg) => dispatchFeature('trusted:add', arg);
export const remove = (arg) => dispatchFeature('trusted:remove', arg);
export const isTrusted = (arg) => dispatchFeature('trusted:isTrusted', arg);
export const filterInsights = (arg) => dispatchFeature('trusted:filterInsights', arg);
