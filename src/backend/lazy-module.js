// Root configuration does not load a cold module. Root changes are init boundaries.
export function createLazyModule(importer) {
  let importing = null, root = null, revision = 0, ready = null;
  let initializing = Promise.resolve();
  const load = () => {
    if (!importing) {
      const pending = Promise.resolve().then(importer).catch((error) => { if (importing === pending) importing = null; throw error; });
      importing = pending;
    }
    return importing;
  };
  return {
    configureRoot(value) { if (value !== root) { root = value; revision++; } },
    async get() {
      const mod = await load();
      while (root !== null) {
        const expected = revision;
        if (!ready || ready.revision !== expected) {
          const configuredRoot = root;
          const state = { revision: expected, promise: null };
          state.promise = initializing.catch(() => {}).then(async () => {
            if (revision === expected) await mod.setRoot(configuredRoot);
          });
          initializing = state.promise;
          ready = state;
        }
        const state = ready;
        try { await state.promise; }
        catch (error) { if (ready === state) ready = null; if (expected === revision) throw error; }
        if (expected === revision) return mod;
      }
      return mod;
    },
  };
}
