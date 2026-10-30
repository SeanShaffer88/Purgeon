// Browser-safe contracts shared by the production bridge and feature modules.
/** @param {string} text */
export async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {unknown} rows @param {string[]} required @returns {Record<string, any>} */
export function objectResult(rows, required = []) {
  const value = Array.isArray(rows) ? (rows.length === 1 ? rows[0] : null) : rows;
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some((key) => !(key in value))) {
    throw new Error('Windows returned an unexpected response. No changes were made by this query.');
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {unknown} id @returns {string} */
export function pluginId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid plugin id');
  return id;
}

/** @param {Record<string, unknown>} value */
export const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
