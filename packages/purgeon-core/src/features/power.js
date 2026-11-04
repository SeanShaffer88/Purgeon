import { dispatchFeature } from '../runtime.js';
export const state = (arg) => dispatchFeature('power:state', arg);
export const setPlan = (arg) => dispatchFeature('power:setPlan', arg);
export const setTimeout = (arg) => dispatchFeature('power:setTimeout', arg);
export const setBatterySaver = (arg) => dispatchFeature('power:setBatterySaver', arg);
export const setWakeTimers = (arg) => dispatchFeature('power:setWakeTimers', arg);
export const setUsbSuspend = (arg) => dispatchFeature('power:setUsbSuspend', arg);
