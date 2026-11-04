import { registerRuntime, initializeRuntime } from 'purgeon-core/runtime';
import { list } from 'purgeon-core/programs';
import { join } from 'purgeon-core/winpath';

// Supply an adapter implementing the selected feature's Windows/native contracts.
export async function inspectPrograms(host, confirm) {
  registerRuntime({ host, confirm });
  await initializeRuntime();
  return { programs: await list('desktop'), dataRoot: join(host.info.dataDir, 'programs') };
}
