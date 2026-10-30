// Per-view sampling: timer ticks coalesce; actions request at most one trailing read.
export function createRefreshGate(sample, receive, fail) {
  let active = true, pending = null, trailing = false;
  const request = (force = false) => {
    if (!active) return Promise.resolve();
    if (pending) { if (force) trailing = true; return pending; }
    pending = (async () => {
      do {
        trailing = false;
        try { const value = await sample(); if (active) receive(value); }
        catch (error) { if (active) fail(error); }
      } while (active && trailing);
    })().finally(() => { pending = null; });
    return pending;
  };
  return { request, dispose: () => { active = false; trailing = false; } };
}
