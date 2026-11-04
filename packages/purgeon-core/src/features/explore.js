import { dispatchFeature } from '../runtime.js';
export const diskMap = (arg) => dispatchFeature('explore:diskMap', arg);
export const diskMapCancel = (arg) => dispatchFeature('explore:diskMapCancel', arg);
export const timeline = (arg) => dispatchFeature('explore:timeline', arg);
export const search = (arg) => dispatchFeature('registry:search', arg);
