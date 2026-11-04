/** Private compatibility boundary; supported consumers use feature subpaths. */
export const api: {
  invoke(channel: string, argument?: unknown, admission?: {requiresApproval: boolean; approve(): Promise<void>}): Promise<any>;
  onMeasured(listener: (value: unknown) => void): () => boolean;
};
export function initBackend(owner?: 'app' | 'public'): Promise<void>;
export function setConfirmUI(callback: (options: any) => Promise<any>): void;
export const __handlers: Record<string, (argument?: any) => any>;
export function runUninstaller(program: unknown): Promise<unknown>;
export function mutates(channel: string): boolean;
