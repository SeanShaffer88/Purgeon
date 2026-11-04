import type { AvAcknowledgeRequest, AvAcknowledgeResult, AvInventory, AvPlan, AvLaunchResult, AvCancelResult, AvStatus } from '../internal/system-contracts.js';
export function list(): Promise<AvInventory>;
export function prepare(request: {productId: string}): Promise<AvPlan>;
export function launch(request: {planId: string}): Promise<AvLaunchResult>;
export function cancel(request: {planId: string}): Promise<AvCancelResult>;
export function status(request: {planId: string}): Promise<AvStatus>;
export function acknowledge(request: AvAcknowledgeRequest): Promise<AvAcknowledgeResult>;
