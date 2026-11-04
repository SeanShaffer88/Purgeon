import { dispatchFeature } from '../runtime.js';
export const run = (arg) => dispatchFeature('health:run', arg);
export const cancel = (arg) => dispatchFeature('health:cancel', arg);
export const weekly = (arg) => dispatchFeature('health:weekly', arg);
export const setWeekly = (arg) => dispatchFeature('health:setWeekly', arg);
export const saveReport = (arg) => dispatchFeature('health:saveReport', arg);
