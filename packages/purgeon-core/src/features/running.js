import { dispatchFeature } from '../runtime.js';
export const bootImpact = (arg) => dispatchFeature('running:bootImpact', arg);
export const inbound = (arg) => dispatchFeature('running:inbound', arg);
