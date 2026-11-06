// Read-only advice contains neither removal grants nor device identifiers.
import { sys } from './sys.js';

const MAX_PACKAGES = 512;
const MAX_DEVICES = 32768;
const validInf = (value) => typeof value === 'string' && /^oem\d{1,10}\.inf$/i.test(value);
const unavailable = () => ({ status: 'unavailable', packages: [] });
const validCount = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_DEVICES;
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);

function bindings(value) {
  if (value === null) return null;
  if (!value || !validCount(value.present) || !validCount(value.nonPresent) || !validCount(value.unknown)
      || value.present + value.nonPresent + value.unknown > MAX_DEVICES) return undefined;
  return { present: value.present, nonPresent: value.nonPresent, unknown: value.unknown };
}

export async function driverRetirementAdvice() {
  try {
    const reply = await sys.driverRetirementAdvisor?.();
    if (!reply || !Array.isArray(reply.packages) || reply.packages.length > MAX_PACKAGES) return unavailable();
    if (reply.status === 'deviceOnly') {
      if (reply.packages.length) return unavailable();
      const observed = reply.deviceBindings ?? [];
      if (!Array.isArray(observed) || observed.length > MAX_PACKAGES) return unavailable();
      const deviceBindings = [];
      const seen = new Set();
      for (const row of observed) {
        if (!row || !validInf(row.inf)) return unavailable();
        const key = row.inf.toLowerCase();
        const counts = bindings(row.counts);
        if (!counts || seen.has(key) || !(counts.present || counts.nonPresent || counts.unknown)) return unavailable();
        seen.add(key);
        deviceBindings.push({ inf: row.inf, counts });
      }
      return { status: 'deviceOnly', packages: [], deviceBindings };
    }
    if (!['complete', 'partial'].includes(reply.status) || reply.deviceBindings !== undefined) return unavailable();
    const packages = [];
    const seen = new Set();
    for (const row of reply.packages) {
      if (!row || !validInf(row.published)
          || !text(row.provider, 120) || !text(row.className, 80) || !text(row.version, 43)
          || !/^\d{1,10}(\.\d{1,10}){3}$/.test(row.version)
          || ![0, 1, 2].includes(row.signature) || typeof row.bootCritical !== 'boolean') return unavailable();
      const key = row.published.toLowerCase();
      const observed = bindings(row.bindings);
      if (seen.has(key) || observed === undefined
          || (reply.status === 'complete' && (observed === null || observed.unknown > 0))) return unavailable();
      seen.add(key);
      packages.push({ published: row.published, provider: row.provider, className: row.className,
        version: row.version, signature: row.signature, bootCritical: row.bootCritical, bindings: observed });
    }
    return { status: reply.status, packages };
  } catch {
    return unavailable();
  }
}
