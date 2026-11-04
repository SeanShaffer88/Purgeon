export function parseCounts(output) {
  const pass = output.match(/^(?:#|ℹ)\s+pass\s+(\d+)\s*$/mu);
  const fail = output.match(/^(?:#|ℹ)\s+fail\s+(\d+)\s*$/mu);
  if (!pass || !fail) throw new Error('Missing or malformed test summary.');
  return { pass: Number(pass[1]), fail: Number(fail[1]) };
}

export function requireSuccess(result) {
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(`Child command failed (${result.signal || (result.status ?? 'no exit status')}).\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result.stdout || '';
}
