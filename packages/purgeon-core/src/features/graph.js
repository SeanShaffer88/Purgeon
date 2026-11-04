import { dispatchFeature } from '../runtime.js';
export const graph = (arg) => dispatchFeature('graph:graph', arg);
export const graphCancel = (arg) => dispatchFeature('graph:graphCancel', arg);
export const program = (arg) => dispatchFeature('graph:program', arg);
export const removeOrphan = (arg) => dispatchFeature('graph:removeOrphan', arg);
