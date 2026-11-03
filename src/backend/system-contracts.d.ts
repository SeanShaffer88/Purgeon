// Production adapter contract. This is an incremental gate, not whole-product typing.
export interface NativeSystemInfo {
  pid: number;
  env: Record<string, string>; home: string; data_dir: string; exe: string;
  portable: boolean; args: string[]; launch?: string[]; cpu?: string;
  ram_bytes?: number; os_name?: string; os_version?: string; os_build?: number;
}
export interface ProcessIdentity { pid: number; name: string; creationTime: string }
export interface TransferReplacementReceipt {
  version: 1; target: string; sid: string; machine: string; infoName: string; infoSha256: string;
  identity: {volume: number; high: number; low: number}; directory: boolean; digest: string;
}
export interface TransferTarget { kind: 'file' | 'dir' | 'key' | 'value'; path: string; name?: string }
export interface TransferState { version: 1; exists: boolean; digest: string | null; identity: {volume: number; high: number; low: number} | null }
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
  observeTransferTarget(target: TransferTarget): Promise<TransferState>;
  acquireTransferUndo(id: string): Promise<string>;
  reserveTransferRestore(): Promise<{id: string; token: string}>;
  releaseTransferUndo(token: string): Promise<void>;
  stageTransferUndo(token: string, id: string, step: number, target: TransferTarget, expected: TransferState, apply: boolean): Promise<boolean>;
  savedTransferUndoStage(token: string, id: string, step: number, target: TransferTarget, expected: TransferState): Promise<boolean>;
  transferOriginalAtTarget(target: string, receipt: TransferReplacementReceipt): Promise<boolean>;
  captureTransferReplacement(target: string, directory: boolean): Promise<TransferReplacementReceipt>;
  validateTransferReplacement(target: string, receipt: TransferReplacementReceipt): Promise<void>;
  restoreTransferReplacement(target: string, receipt: TransferReplacementReceipt): Promise<{restored: boolean}>;
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
  reserveUpdateDownload(expected: {sha256:string;size:number}): Promise<{id:string;path:string}>;
  cancelUpdateDownload(id:string): Promise<{removed:boolean;detail:string}>;
  launchVerifiedUpdate(id:string): Promise<void>;
  bootState(): Promise<{timeout: number | null; safeboot: 'none' | 'minimal' | 'network' | 'other'; entries: Array<{id: string; name: string; isCurrent: boolean; isDefault: boolean}>}>;
  taskInventory(cursor?:string|null):Promise<{rows:Array<{name:string;path:string;state:string;taskId:string|null;enabled:boolean|null;[key:string]:unknown}>;nextCursor:string|null}>;
  taskOwnedStatus(role:'signin'|'maintenance'|'background'):Promise<{registered:boolean;enabled:boolean;owned:boolean;nextRun:string;lastRun:string;lastResult:number|null}>;
  selectTaskProgram():Promise<{id:string;displayPath:string}|null>;
  prepareTask(request:unknown):Promise<{id:string;summary:string;requiresElevation:boolean}>;
  executeTask(planId:string):Promise<{ok:boolean;journalId:string;changed:boolean;settled:boolean;recoverable:boolean;detail:string}>;
  taskRecovery(journalId:string):Promise<{journalId:string;completed:boolean;recovered:boolean;recoverable:boolean;deleted:boolean;path:string}>;
  driverInventory(): Promise<Array<{PublishedName:string; OriginalName:string; InfFile:string; Date:string; Version:string; Provider:string; DriverClass:string; driverId:string|null; eligible:boolean; reason:string|null}>>;
  prepareDriver(request:{kind:'remove';driverId:string}|{kind:'recover';journalId:string}):Promise<{id:string;summary:string;requiresElevation:boolean}>;
  executeDriver(planId:string):Promise<{ok:boolean;journalId:string;stagedOnly:boolean;detail:string}>;
  driverRecovery(journalId:string):Promise<unknown>;
  prepareBoot(request: {kind: 'safeBoot'; mode: 'none' | 'minimal' | 'network'} | {kind: 'timeout'; seconds: number} | {kind: 'undo'; journalId: string}): Promise<{id: string; summary: string; requiresElevation: boolean}>;
  executeBoot(planId: string): Promise<{ok: boolean; journalId: string}>;
  debloatStatus(): Promise<Array<{ id: string; enabled: boolean; partial: boolean; unknown: boolean; error: string | null }>>;
  prepareDebloat(request: { tweakId: string; enabled: boolean }): Promise<{ id: string; summary: string; effect: string; requiresElevation: boolean }>;
  prepareDebloatRecovery(request: { tweakId: string; transactionId: string; decision: 'reconcile' | 'rollbackOwned' | 'acceptCurrent' }): Promise<{ id: string; summary: string; effect: string; requiresElevation: boolean }>;
  executeDebloat(planId: string): Promise<{ ok: boolean; restoredOriginal: boolean; appliedDefaults: boolean; outcome: string }>;
  [key: string]: unknown;
}
