// Explicit in-memory admission adapter. Native tests establish OS exclusion;
// this fixture only establishes JavaScript lock ownership and nesting.
export function recoveryLeaseFixture() {
  let held;
  return {
    assertRecoveryToken: (token) => {
      if (!held || held !== token) throw new Error('Missing or foreign recovery execution token');
    },
    acquireRecoveryLease: async () => {
      if (held) throw new Error('Recovery busy; no operation was started');
      held = Symbol('fixture recovery lease');
      return held;
    },
    releaseRecoveryLease: async (token) => {
      if (!held || held !== token) throw new Error('Foreign recovery lease');
      held = undefined;
    },
  };
}
