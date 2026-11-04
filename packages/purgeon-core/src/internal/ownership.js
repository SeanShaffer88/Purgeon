let owner = null;
export function claim(kind) {
  if (owner && owner !== kind) throw new Error('Backend already owned by ' + owner);
  owner = kind;
}
export function assertAppAccess() {
  if (owner === 'public') throw new Error('Backend already owned by public runtime');
}
