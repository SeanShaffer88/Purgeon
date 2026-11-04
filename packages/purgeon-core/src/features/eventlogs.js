import { dispatchFeature } from '../runtime.js';
export const channels = (arg) => dispatchFeature('logs:channels', arg);
export const exportPick = (arg) => dispatchFeature('logs:exportPick', arg);
export const clear = (arg) => dispatchFeature('logs:clear', arg);
export const setEnabled = (arg) => dispatchFeature('logs:setEnabled', arg);
export const undoEnabled = (arg) => dispatchFeature('logs:undoEnabled', arg);
