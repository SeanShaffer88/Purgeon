import { dispatchFeature } from '../runtime.js';
export const available = (arg) => dispatchFeature('winget:available', arg);
export const upgrades = (arg) => dispatchFeature('winget:upgrades', arg);
export const upgrade = (arg) => dispatchFeature('winget:upgrade', arg);
export const find = (arg) => dispatchFeature('winget:find', arg);
export const install = (arg) => dispatchFeature('winget:install', arg);
export const repair = (arg) => dispatchFeature('winget:repair', arg);
export const exportTo = (arg) => dispatchFeature('winget:exportTo', arg);
export const exportList = (arg) => dispatchFeature('winget:export', arg);
