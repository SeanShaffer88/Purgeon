import { sys } from './sys.js';

const invalidResponse = () => { throw new Error('Windows returned an invalid security-software response. Review operation status before retrying.'); };
const text = value => typeof value === 'string' && value.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const opaque = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const tool = value => ['avg', 'avast', 'norton', 'mcafee'].includes(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => text(value) && Number.isFinite(Date.parse(value));
function request(argument, key) {
  if (!record(argument) || Object.getPrototypeOf(argument) !== Object.prototype || Reflect.ownKeys(argument).length !== 1 || !Object.hasOwn(argument, key)
      || !('value' in Object.getOwnPropertyDescriptor(argument, key)) || !opaque(argument[key])) throw new Error('Invalid security-software request. Refresh and select a native product or plan.');
  return argument[key];
}
export function acknowledgeRequest(argument) {
  if (!record(argument) || Object.getPrototypeOf(argument) !== Object.prototype || Reflect.ownKeys(argument).length !== 2
      || !['reviewId', 'acknowledgment'].every(key => Object.hasOwn(argument, key) && 'value' in Object.getOwnPropertyDescriptor(argument, key))
      || !opaque(argument.reviewId) || argument.acknowledgment !== 'reviewedUtilityClosed') throw new Error('Invalid security-software acknowledgment request.');
  return { reviewId: argument.reviewId, acknowledgment: argument.acknowledgment };
}
export async function acknowledge(argument) {
  const request = acknowledgeRequest(argument);
  const value = await sys.acknowledgeSecuritySoftwareRemoval(request);
  if (!record(value) || value.reviewId !== request.reviewId || value.outcome !== 'acknowledged') invalidResponse();
  return { reviewId: value.reviewId, outcome: value.outcome };
}
export async function checkHandoff(argument) {
  const reviewId = request(argument, 'reviewId');
  const value = await sys.checkSecuritySoftwareHandoff({ reviewId });
  if (!record(value) || value.reviewId !== reviewId || !(value.productName === null || text(value.productName))
      || !['observed', 'notObserved', 'unknown'].includes(value.registration)
      || !['good', 'notMonitored', 'poor', 'snoozed', 'unknown'].includes(value.antivirusHealth)
      || !timestamp(value.observedAt) || (value.productName === null && value.registration !== 'unknown')) invalidResponse();
  return { reviewId, productName: value.productName, registration: value.registration, antivirusHealth: value.antivirusHealth, observedAt: value.observedAt };
}
export const launchRequest = argument => ({ planId: request(argument, 'planId') });
function shapeStatus(value, id) {
  if (!record(value) || value.id !== id || !['prepared', 'downloading', 'verifying', 'launching', 'launched', 'cancelled', 'failed', 'reviewRequired', 'acknowledged'].includes(value.phase)
      || !Number.isSafeInteger(value.bytesReceived) || value.bytesReceived < 0 || typeof value.cancellationRequested !== 'boolean'
      || !['none', 'pending', 'removed', 'retained'].includes(value.cleanup) || !text(value.detail)) invalidResponse();
  return { id, phase: value.phase, bytesReceived: value.bytesReceived, cancellationRequested: value.cancellationRequested, cleanup: value.cleanup, detail: value.detail };
}
export async function list(argument) {
  if (argument !== undefined) throw new Error('Invalid security-software inventory request.');
  const value = await sys.securitySoftwareInventory();
  if (!record(value) || !Array.isArray(value.products) || value.products.length > 4096 || !Array.isArray(value.sources) || value.sources.length > 64
      || !Array.isArray(value.reviews) || value.reviews.length > 64
      || typeof value.complete !== 'boolean' || !timestamp(value.observedAt)) invalidResponse();
  const products = value.products.map(row => {
    if (!record(row) || !opaque(row.id) || ![row.name, row.publisher, row.version, row.category].every(text)
        || !Array.isArray(row.sources) || row.sources.length > 64 || !row.sources.every(text) || !(row.toolId === null || tool(row.toolId))
        || !(row.unsupportedReason === null || text(row.unsupportedReason)) || !(row.helpUrl === null || row.helpUrl === 'https://support.eset.com/en/kb2289-uninstall-eset-manually-using-the-eset-uninstaller-tool') || typeof row.builtIn !== 'boolean') invalidResponse();
    return { id: row.id, name: row.name, publisher: row.publisher, version: row.version, sources: [...row.sources], category: row.category, toolId: row.toolId, unsupportedReason: row.unsupportedReason, builtIn: row.builtIn, helpUrl: row.helpUrl };
  });
  const sources = value.sources.map(row => {
    if (!record(row) || !text(row.id) || !['ok', 'unavailable', 'error'].includes(row.status) || !text(row.detail)) invalidResponse();
    return { id: row.id, status: row.status, detail: row.detail };
  });
  const reviews = value.reviews.map(row => {
    if (!record(row) || !opaque(row.reviewId) || !(tool(row.toolId) || (row.toolId === null && row.state === 'unreadable' && row.canAcknowledge === false)) || !(row.planId === null || opaque(row.planId))
        || !['reviewRequired', 'unreadable'].includes(row.state) || !text(row.detail) || typeof row.canAcknowledge !== 'boolean'
        || (row.state === 'unreadable' && row.canAcknowledge) || (row.state === 'reviewRequired' && !opaque(row.planId))) invalidResponse();
    return { reviewId: row.reviewId, toolId: row.toolId, planId: row.planId, state: row.state, detail: row.detail, canAcknowledge: row.canAcknowledge };
  });
  return { products, sources, reviews, complete: value.complete, observedAt: value.observedAt };
}
export async function prepare(argument) {
  const productId = request(argument, 'productId');
  const value = await sys.prepareSecuritySoftwareRemoval({ productId });
  if (!record(value) || !opaque(value.id) || value.productId !== productId || !tool(value.toolId)
      || ![value.productName, value.toolName, value.recoveryLimits].every(text) || !timestamp(value.expiresAt)) invalidResponse();
  return { id: value.id, productId, toolId: value.toolId, productName: value.productName, toolName: value.toolName, recoveryLimits: value.recoveryLimits, expiresAt: value.expiresAt };
}
export async function launch(argument) {
  const id = request(argument, 'planId');
  const value = await sys.launchSecuritySoftwareRemoval(id);
  if (!record(value) || value.id !== id || !['launched', 'cancelled', 'failed', 'reviewRequired'].includes(value.outcome) || !text(value.detail)) invalidResponse();
  return { id, outcome: value.outcome, detail: value.detail };
}
export async function cancel(argument) {
  const id = request(argument, 'planId');
  const value = await sys.cancelSecuritySoftwareRemoval(id);
  if (!record(value) || typeof value.accepted !== 'boolean') invalidResponse();
  return { accepted: value.accepted, status: shapeStatus(value.status, id) };
}
export async function status(argument) {
  const id = request(argument, 'planId');
  return shapeStatus(await sys.securitySoftwareRemovalStatus(id), id);
}
