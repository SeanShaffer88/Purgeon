const terminal = new Set(['launched', 'cancelled', 'failed', 'reviewRequired', 'acknowledged']);
// The canonical API validates native status; also fail closed for injected hosts.
const knownPrelaunchStop = (status, id) => status !== null && typeof status === 'object' && !Array.isArray(status)
  && status.id === id && ['failed', 'cancelled'].includes(status.phase)
  && Number.isSafeInteger(status.bytesReceived) && status.bytesReceived >= 0
  && typeof status.cancellationRequested === 'boolean' && ['none', 'pending', 'removed', 'retained'].includes(status.cleanup)
  && typeof status.detail === 'string' && status.detail.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(status.detail);
export const canRunSecurityProduct = p => !!p?.toolId && !p.builtIn && !p.unsupportedReason;
export const isSecurityRunEligible = (product, state) => canRunSecurityProduct(product) && !state.busy && !state.reviewBlocked && !state.inventory?.reviews?.length;
export const securitySoftwareStatus = (state, count) => state.loading ? 'Reading installed security software…' : `${count} security products · ${state.message || 'Select a product to inspect its utility'}`;
export function createSecuritySoftwareController({ invoke, confirm, confirmReview = async () => false, onChange, onError, schedule = setTimeout, unschedule = clearTimeout }) {
  let alive = true, busy = false, timer, plan, loadId = 0, generation = 0, polls = 0, launched = false, cancellationRequested = false;
  let handoffId = 0;
  const blocked = new Set();
  let state = { inventory: null, loading: true, phase: '', message: '', busy: false };
  const update = patch => { state = { ...state, ...patch, reviewBlocked: blocked.size > 0 }; if (alive) onChange(state); };
  const report = e => { if (alive) onError(e.message || String(e)); };
  const cancelPlan = async id => invoke('securitySoftware:cancel', { planId: id });
  const current = (operation, id) => alive && busy && operation === generation && plan?.id === id;
  const poll = async (operation, id) => {
    if (!current(operation, id) || ++polls > 180) return;
    try {
      const status = await invoke('securitySoftware:status', { planId: id });
      if (!current(operation, id)) return;
      update({ phase: status.phase, message: status.detail || status.phase });
      if (!terminal.has(status.phase)) timer = schedule(() => poll(operation, id), 1000);
    } catch (e) { if (current(operation, id)) report(e); }
  };
  return {
    async load() {
      if (!alive || busy) return;
      const id = ++loadId;
      handoffId++;
      update({ loading: true, handoff: null });
      try { const inventory = await invoke('securitySoftware:list'); if (alive && id === loadId) update({ inventory, loading: false }); }
      catch (e) { if (alive && id === loadId) { update({ inventory: null, loading: false }); report(e); } }
    },
    async run(product) {
      if (!alive || !isSecurityRunEligible(product, state)) return;
      const operation = ++generation; loadId++; handoffId++;
      let currentPlan;
      busy = true; launched = false; cancellationRequested = false; plan = null; polls = 0;
      update({ busy: true, loading: false, handoff: null, phase: 'preparing', message: 'Preparing utility details…' });
      try {
        currentPlan = await invoke('securitySoftware:prepare', { productId: product.id });
        if (!alive || operation !== generation) { await cancelPlan(currentPlan.id); return; }
        plan = currentPlan;
        const id = currentPlan.id;
        update({ phase: 'prepared', message: 'Waiting for confirmation…' });
        let approved = false, asked = false;
        try {
          const result = await invoke('securitySoftware:launch', { planId: plan.id }, {
            requiresApproval: true,
            approve: async () => {
              if (asked) throw Error('Utility approval already requested.');
              asked = true;
              if (!current(operation, id) || cancellationRequested || !(await confirm(currentPlan)) || !current(operation, id) || cancellationRequested) throw Error('Utility launch cancelled.');
              approved = true; launched = true;
              update({ phase: 'downloading', message: 'Downloading and verifying vendor utility…' });
              timer = schedule(() => poll(operation, id), 1000);
              return true;
            },
          });
          if (!current(operation, id)) return;
          const phase = terminal.has(result?.outcome) ? result.outcome : 'reviewRequired';
          if (phase === 'launched' || phase === 'reviewRequired') blocked.add(product.toolId);
          update({ phase, message: phase === 'launched' ? 'Vendor utility launched. Complete its steps, then refresh the inventory.' : phase === 'reviewRequired' ? result?.detail || 'The utility may have started. Review its windows; automatic relaunch is blocked.' : result?.detail || phase });
        } catch (e) {
          if (!current(operation, id)) return;
          if (!approved) {
            await cancelPlan(id);
            if (!current(operation, id)) return;
            update({ phase: 'cancelled', message: 'Utility launch cancelled.' });
          } else {
            let status;
            try { status = await invoke('securitySoftware:status', { planId: id }); }
            catch { if (!current(operation, id)) return; }
            if (!current(operation, id)) return;
            if (knownPrelaunchStop(status, id)) {
              update({ phase: status.phase, message: status.detail || (status.phase === 'failed' ? 'Utility failed before launch. Select the product to prepare a fresh plan.' : 'Utility launch cancelled.') });
            } else {
              blocked.add(product.toolId);
              update({ phase: 'reviewRequired', message: 'Launch outcome is uncertain. The utility may have started. Review its windows before doing anything else.' });
              report(e);
            }
          }
        }
      } catch (e) { if (alive && operation === generation) { update({ phase: 'failed', message: e.message }); report(e); } }
      finally { if (operation === generation) { busy = false; unschedule(timer); update({ busy: false }); } }
    },
    async checkHandoff(review) {
      const reviewId = review?.reviewId;
      if (!alive || busy || state.loading || state.handoff?.pending
          || !state.inventory?.reviews?.some(row => row.reviewId === reviewId && row.canAcknowledge && row.state === 'reviewRequired')) return;
      const id = ++handoffId;
      const currentCheck = () => alive && handoffId === id;
      update({ handoff: { reviewId, pending: true } });
      try {
        const result = await invoke('securitySoftware:checkHandoff', { reviewId });
        if (!currentCheck()) return;
        if (result?.reviewId !== reviewId) throw Error('Review no longer matches.');
        update({ handoff: { reviewId, result } });
      } catch {
        if (currentCheck()) update({ handoff: { reviewId, unavailable: true } });
      }
    },
    async acknowledge(review) {
      if (!alive || busy || !review?.canAcknowledge || review.state !== 'reviewRequired') return;
      const operation = ++generation;
      busy = true; loadId++; handoffId++;
      update({ busy: true, loading: false, handoff: null, message: 'Waiting for acknowledgment confirmation…' });
      let asked = false;
      try {
        const result = await invoke('securitySoftware:acknowledge', { reviewId: review.reviewId, acknowledgment: 'reviewedUtilityClosed' }, {
          requiresApproval: true,
          approve: async () => {
            if (asked) throw Error('Acknowledgment approval already requested.');
            asked = true;
            if (!alive || operation !== generation || !(await confirmReview(review)) || !alive || operation !== generation) throw Error('Acknowledgment cancelled.');
            return true;
          },
        });
        if (!alive || operation !== generation) return;
        if (result?.reviewId !== review.reviewId || result?.outcome !== 'acknowledged') throw Error('Acknowledgment outcome is unknown. The previous attempt remains blocked.');
        blocked.delete(review.toolId);
        update({ phase: 'acknowledged', message: 'Previous attempt acknowledged. Select the product to prepare a fresh launch plan.' });
        const inventory = await invoke('securitySoftware:list');
        if (alive && operation === generation) update({ inventory, loading: false });
      } catch (e) { if (alive && operation === generation) report(e); }
      finally { if (operation === generation) { busy = false; update({ busy: false }); } }
    },
    async cancel() {
      if (!alive || !plan || !busy || state.phase === 'launching') return;
      const operation = generation, id = plan.id;
      cancellationRequested = true;
      try {
        const result = await cancelPlan(id);
        if (current(operation, id)) update({ phase: result.status.phase, message: result.accepted ? 'Cancellation requested. Waiting for the native operation to stop.' : result.status.detail || 'Launch has already begun; cancellation is unavailable.' });
      } catch (e) { if (current(operation, id)) report(e); }
    },
    dispose() {
      alive = false; loadId++; handoffId++; unschedule(timer);
      if (plan && (!launched || ['prepared', 'downloading', 'verifying'].includes(state.phase))) cancelPlan(plan.id).catch(() => {});
    },
  };
}
