import { sys } from './sys.js';

const validId = id => typeof id === 'string' && /^[a-f0-9]{12}$/.test(id);

export async function generateInstallerLab() {
  const result = await sys.generateInstallerLab();
  if (result === null) return null;
  if (!result || !validId(result.id) || typeof result.folder !== 'string'
    || !/^[a-z]:\\[^\p{Cc}]{1,240}$/iu.test(result.folder)
    || typeof result.installerName !== 'string' || !/^[^\\/:\p{Cc}]{1,240}\.(exe|msi)$/iu.test(result.installerName)
    || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) {
    throw new Error('Windows returned invalid installer lab details.');
  }
  const { id, folder, installerName, sha256 } = result;
  return { id, folder, installerName, sha256 };
}

export async function openInstallerLabFolder({ id } = {}) {
  if (!validId(id)) throw new Error('Invalid lab identity.');
  await sys.openInstallerLabFolder(id);
}

export function readInstallerLabCode({ id, code } = {}) {
  if (!validId(id) || typeof code !== 'string' || code.length > 64) throw new Error('Invalid lab report code.');
  const text = code.trim().toUpperCase();
  const parsed = /^P1-([0-9A-F]{12})-([0-7])-([0-9A-F]{4})-([0-9A-F]{4})-([0-9A-F]{4})-([0-9A-F]{8})$/.exec(text);
  if (!parsed) throw new Error('Invalid lab report code.');
  const [, lab, ...fields] = parsed;
  const [coverage, added, missing, changed, checksum] = fields.map(field => Number.parseInt(field, 16));
  // This checksum detects transcription mistakes. The guest can forge the code.
  let hash = 0x811c9dc5;
  for (const char of text.slice(0, -9)) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  const maximum = 1024 * ((coverage & 1) + ((coverage >> 1) & 1) + ((coverage >> 2) & 1));
  if ((hash >>> 0) !== checksum || added + changed > maximum || missing + changed > maximum) {
    throw new Error('Invalid lab report code.');
  }
  if (lab !== id.toUpperCase()) throw new Error('This report code belongs to a different lab.');
  return { coverage, added, missing, changed };
}
