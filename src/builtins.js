// Built-in program groups: membership is computed live from a program row and
// its insights, never stored. They sit above the user's own groups in the
// group picker and filter the list the same way. The control-character ids
// cannot collide with a user group name.
export const BUILTIN_GROUPS = [
  ['\u0001offer', 'Bundled software (possible offers)', (r, i) => i?.offer],
  ['\u0001together', 'Installed together with another', (r, i) => i?.together],
  ['\u0001unsigned', 'Unsigned', (r, i) => i?.signature === 'NotSigned'],
  ['\u0001badsig', 'Bad signature', (r, i) => i?.signature && i.signature !== 'Valid' && i.signature !== 'NotSigned'],
  ['\u0001growing', 'Growing in size', (r, i) => i?.growth],
  ['\u0001large', 'Large programs (1 GB or more)', (r) => (r.sizeKB || r.sortSize || 0) >= 1024 * 1024],
  ['\u0001recent', 'Recently installed (30 days)', (r) => { const d = new Date(r.date || r.installDate || 0).getTime(); return d > 0 && d >= Date.now() - 30 * 86400000; }],
  ['\u0001microsoft', 'Microsoft', (r) => /microsoft/i.test(r.publisher || '')],
  ['\u0001nopublisher', 'No publisher listed', (r) => !(r.publisher || '').trim()],
  ['\u0001games', 'Games', (r) => { const loc = r.location || ''; return /steamapps[\\/]common[\\/]/i.test(loc) || /[\\/]gog games[\\/]/i.test(loc) || (/[\\/]epic games[\\/]/i.test(loc) && !/epic games[\\/]launcher/i.test(loc)); }],
];

export const builtinById = (id) => BUILTIN_GROUPS.find(([x]) => x === id);
