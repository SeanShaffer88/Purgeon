// Production adapter contract. This is an incremental gate, not whole-product typing.
export interface NativeSystemInfo {
  pid: number;
  env: Record<string, string>; home: string; data_dir: string; exe: string;
  portable: boolean; args: string[]; launch?: string[]; cpu?: string;
  ram_bytes?: number; os_name?: string; os_version?: string; os_build?: number;
}
export interface ProcessIdentity { pid: number; name: string; creationTime: string }
export interface SystemAdapter {
  info: { version: string; env: Record<string, string>; home: string; dataDir: string; exe: string; portable: boolean; args: string[]; launch: string[]; [key: string]: unknown };
  queryOperation(request: { kind: 'eventLogChannels' } | { kind: 'eventLogConfig'; channelId: string } | { kind: 'eventLogRecovery'; journalId: string }): Promise<unknown>;
  selectResource(selection: { kind: 'eventLogExportDestination'; channelId: string }): Promise<{ id: string; displayPath: string } | null>;
  prepareOperation(request: { kind: 'eventLogClear'; channelId: string } | { kind: 'eventLogSetEnabled'; channelId: string; enabled: boolean } | { kind: 'eventLogExport'; channelId: string; destinationGrant: string }): Promise<{ id: string; summary: string; requiresElevation: boolean; recoveryLimits: string }>;
  executeOperation(planId: string): Promise<unknown>;
  recoverOperation(request: { journalId: string; decision: 'acknowledgeObserved' }): Promise<{ id: string; summary: string; requiresElevation: boolean; recoveryLimits: string }>;
  cancelOperation(planId: string): Promise<{ cancelled: boolean; phase: string }>;
  runPS(script: string, input?: string, timeoutMs?: number): Promise<string>;
  copyFile(source: string, target: string): Promise<number>;
  commitStagedFile(source: string, target: string): Promise<void>;
  readOptionalText(path: string): Promise<string | null>;
  restorePoints(): Promise<Array<{ sequence: number; created: string; description: string }>>;
  prepareRestoreRemoval(request: { sequence: number; expectedCreationTime: string; expectedDescription: string }): Promise<{ id: string; summary: string; requiresElevation: boolean }>;
  executeRestoreRemoval(planId: string): Promise<{ ok: boolean; sequence: number; journalId: string }>;
  secretGet(): Promise<string>;
  secretKeys(): Promise<string[]>;
  secretSet(value: string): Promise<void>;
  trackPeek(): Promise<{ processes: number; events: number }>;
  prepareProcess(request: { pid: number; creationTime: string; action: { kind: string; level?: string; mask?: string } }): Promise<{ id: string; summary: string; image: string; requiresElevation: boolean }>;
  executeProcess(planId: string): Promise<{ ok: boolean; previousPriority: string | null; error: string | null }>;
  elevateHandoff(): Promise<void>;
  debloatStatus(): Promise<Array<{ id: string; enabled: boolean; partial: boolean; unknown: boolean; error: string | null }>>;
  prepareDebloat(request: { tweakId: string; enabled: boolean }): Promise<{ id: string; summary: string; effect: string; requiresElevation: boolean }>;
  prepareDebloatRecovery(request: { tweakId: string; transactionId: string; decision: 'reconcile' | 'rollbackOwned' | 'acceptCurrent' }): Promise<{ id: string; summary: string; effect: string; requiresElevation: boolean }>;
  executeDebloat(planId: string): Promise<{ ok: boolean; restoredOriginal: boolean; appliedDefaults: boolean; outcome: string }>;
  [key: string]: unknown;
}
