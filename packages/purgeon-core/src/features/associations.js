import { dispatchFeature } from '../runtime.js';
export const extensions = (arg) => dispatchFeature('associations:extensions', arg);
export const ownerFor = (arg) => dispatchFeature('associations:ownerFor', arg);
export const extensionsForProgram = (arg) => dispatchFeature('associations:extensionsForProgram', arg);
