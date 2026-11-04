import { dispatchFeature } from '../runtime.js';
export const report = (arg) => dispatchFeature('profiler:report', arg);
export const baseline = (arg) => dispatchFeature('profiler:baseline', arg);
export const regressions = (arg) => dispatchFeature('profiler:regressions', arg);
