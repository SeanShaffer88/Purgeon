import { applyHost } from './internal/sys.js';
import { claim } from './internal/ownership.js';
import { api, initBackend, mutates, setConfirmUI } from './internal/api.js';
let state = 'unregistered';
/** @type {Promise<void> | undefined} */
let initialization;
/** @type {((request: any) => Promise<unknown> | unknown) | undefined} */
let confirm;
export const runtimeState = () => state;
export function subscribeMeasured(listener) {
  if (state !== 'ready') throw new Error('Runtime is not ready');
  if (typeof listener !== 'function') throw new TypeError('Measurement listener must be a function');
  return api.onMeasured(result => listener(structuredClone(result)));
}
export function registerRuntime(options) {
  if (state !== 'unregistered') throw new Error('Runtime already registered');
  const { host, confirm: approve } = options || {};
  if (!host || typeof host.info?.dataDir !== 'string' || !host.info.dataDir ||
      ['makeDir', 'readDir', 'readText', 'writeTextAtomic'].some(key => typeof host[key] !== 'function') ||
      (approve !== undefined && typeof approve !== 'function')) throw new TypeError('Invalid runtime host or confirmation callback');
  // Copy the adapter and identity before claiming ownership; callers cannot replace them later.
  const adapter = { ...host, info: structuredClone(host.info) };
  claim('public');
  applyHost(adapter);
  confirm = approve;
  setConfirmUI(async options => approve ? (await approve({ kind: 'confirmation', options: structuredClone(options) })) === true : false);
  state = 'registered';
}
export function initializeRuntime() {
  if (state === 'unregistered') return Promise.reject(new Error('Runtime is not registered'));
  if (initialization) return initialization;
  state = 'initializing';
  initialization = initBackend('public').then(() => { state = 'ready'; }, error => { state = 'failed'; throw error; });
  return initialization;
}
// Internal fixed-channel facades are the only public callers of this function.
export async function dispatchFeature(channel, arg) {
  if (state !== 'ready') throw new Error('Runtime is not ready');
  const snapshot = snapshotArgument(arg);
  const requiresApproval = mutates(channel) || !approvalFree.has(channel);
  return api.invoke(channel, snapshot, { requiresApproval, approve: async () => {
    if (!confirm || await confirm({ kind: 'operation', channel, argument: snapshotArgument(snapshot) }) !== true) throw new Error('Explicit approval required for ' + channel);
  } });
}
function snapshotArgument(value) {
  if (value === undefined) return undefined;
  const check = (v) => {
    if (v === null || ['string', 'boolean'].includes(typeof v)) return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (Array.isArray(v)) { v.forEach(check); return; }
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(v))) {
        if (!('value' in descriptor)) throw new TypeError('Operation arguments must be plain data');
        check(descriptor.value);
      }
      return;
    }
    throw new TypeError('Operation arguments must be plain data');
  };
  check(value);
  return structuredClone(value);
}
// Queries can migrate settings, persist caches or invoke host controls. Default to approval.
const approvalFree = new Set('securitySoftware:list securitySoftware:prepare securitySoftware:status securitySoftware:cancel i18n:languages i18n:current profiler:report app:dataDamage programs:measureCancel items:removeCancel backups:restoreCancel backups:verifyCancel erase:runCancel duplicates:scanCancel games:listCancel graph:graphCancel snapshots:cancel junk:scanCancel junk:cleanSystemCancel orphans:scanCancel explore:diskMapCancel disk:scanCancel disk:measureCancel health:cancel'.split(' '));
