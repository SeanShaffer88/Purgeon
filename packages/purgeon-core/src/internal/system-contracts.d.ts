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
export type AvToolId = 'avg' | 'avast' | 'norton' | 'mcafee';
export interface AvReview { reviewId: string; toolId: AvToolId | null; planId: string | null; state: 'reviewRequired' | 'unreadable'; detail: string; canAcknowledge: boolean }
export interface AvAcknowledgeRequest { reviewId: string; acknowledgment: 'reviewedUtilityClosed' }
export interface AvAcknowledgeResult { reviewId: string; outcome: 'acknowledged' }
export interface AvInventory {
  reviews: AvReview[];
  products: Array<{id: string; name: string; publisher: string; version: string; sources: string[]; category: string; toolId: AvToolId | null; unsupportedReason: string | null; builtIn: boolean; helpUrl: string | null}>;
  sources: Array<{id: string; status: 'ok' | 'unavailable' | 'error'; detail: string}>;
  complete: boolean; observedAt: string;
}
export interface AvPlan { id: string; productId: string; toolId: AvToolId; productName: string; toolName: string; recoveryLimits: string; expiresAt: string }
export interface AvStatus { id: string; phase: 'prepared' | 'downloading' | 'verifying' | 'launching' | 'launched' | 'cancelled' | 'failed' | 'reviewRequired' | 'acknowledged'; bytesReceived: number; cancellationRequested: boolean; cleanup: 'none' | 'pending' | 'removed' | 'retained'; detail: string }
export interface AvLaunchResult { id: string; outcome: 'launched' | 'cancelled' | 'failed' | 'reviewRequired'; detail: string }
export interface AvCancelResult { accepted: boolean; status: AvStatus }
export interface SystemAdapter {
  info: { version: string; env: Record<string, string>; home: string; dataDir: string; exe: string; portable: boolean; args: string[]; launch: string[]; [key: string]: unknown };
  acknowledgeSecuritySoftwareRemoval(request: AvAcknowledgeRequest): Promise<AvAcknowledgeResult>;
  securitySoftwareInventory(): Promise<AvInventory>;
  prepareSecuritySoftwareRemoval(request: {productId: string}): Promise<AvPlan>;
  launchSecuritySoftwareRemoval(planId: string): Promise<AvLaunchResult>;
  cancelSecuritySoftwareRemoval(planId: string): Promise<AvCancelResult>;
  securitySoftwareRemovalStatus(planId: string): Promise<AvStatus>;
  queryOperation(request: { kind: 'eventLogChannels' } | { kind: 'eventLogConfig'; channelId: string } | { kind: 'eventLogRecovery'; journalId: string }): Promise<unknown>;
  selectResource(selection: { kind: 'eventLogExportDestination'; channelId: string }): Promise<{ id: string; displayPath: string } | null>;
  prepareOperation(request: { kind: 'eventLogClear'; channelId: string } | { kind: 'eventLogSetEnabled'; channelId: string; enabled: boolean } | { kind: 'eventLogExport'; channelId: string; destinationGrant: string }): Promise<{ id: string; summary: string; requiresElevation: boolean; recoveryLimits: string }>;
  executeOperation(planId: string): Promise<unknown>;
  recoverOperation(request: { journalId: string; decision: 'acknowledgeObserved' }): Promise<{ id: string; summary: string; requiresElevation: boolean; recoveryLimits: string }>;
  cancelOperation(planId: string): Promise<{ cancelled: boolean; phase: string }>;
  acquireRecoveryLease(): Promise<string>;
  releaseRecoveryLease(token: string): Promise<void>;
  runPS(script: string, input?: string, timeoutMs?: number, recoveryToken?: string): Promise<string>;
  exec(file: string, args: string[], recoveryToken?: string): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>;
  copyFile(source: string, target: string): Promise<number>;
  observeTransferTarget(target: TransferTarget): Promise<TransferState>;
  acquireTransferUndo(id: string): Promise<string>;
  reserveTransferRestore(): Promise<{id: string; token: string}>;
  releaseTransferUndo(token: string): Promise<void>;
  pinTransferRegistryExport(token: string, name: string): Promise<{id: string; text: string}>;
  importTransferRegistryExport(token: string, pin: string): Promise<{ok: boolean}>;
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
  consumeUpdateExitMarker?(): Promise<boolean>;
  bootState(): Promise<{timeout: number | null; safeboot: 'none' | 'minimal' | 'network' | 'other'; entries: Array<{id: string; name: string; isCurrent: boolean; isDefault: boolean}>}>;
  taskInventory(cursor?:string|null):Promise<{rows:Array<{name:string;path:string;state:string;taskId:string|null;enabled:boolean|null;[key:string]:unknown}>;nextCursor:string|null}>;
  persistenceTrace?(request:{kind:'run';source:'hkcu-run'|'hklm-run'|'hklm-run32';name:string}|{kind:'task';path:string}):Promise<unknown>;
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
