import { request } from './apiCore.js';

// Beeper Desktop bridge — status card (#30). Read-only connection status
// (token-configured flag, never the token; tri-state reachability; the
// account roster mirrored from beeper_accounts) plus a live "Retry" check.
// Ingestion + connection settings (enabled/intervalMinutes/baseUrl/
// attachmentBudgetGb) go through the generic getSettings/updateSettings pair
// in apiSystem.js, same as iMessage/Signal — this file covers only what
// those don't.
export const getBeeperStatus = (options = {}) => request('/beeper/status', options);
export const checkBeeperConnection = (options = {}) => request('/beeper/status/check', { method: 'POST', ...options });

// Connect flow (#31). PortOS runs OAuth itself (PKCE S256, dynamic client
// registration); `startBeeperOAuth` returns the authorization URL for the
// browser to open, and the redirect lands on the server callback, never here.
// Pasting a token is a first-class alternative — Beeper's own UI can mint a
// no-expiry token and the OAuth surface accepts no lifetime at all. None of
// these ever return a token value: the client only ever sees `tokenConfigured`,
// `tokenExpiresAt` and `tokenSource`.
export const startBeeperOAuth = (options = {}) => request('/beeper/oauth/start', { method: 'POST', ...options });
export const saveBeeperToken = (token, options = {}) => request('/beeper/token', { method: 'POST', body: JSON.stringify({ token }), ...options });
export const disconnectBeeper = (options = {}) => request('/beeper/token', { method: 'DELETE', ...options });

// Outbound outbox (#36, decided on #8). Two calls for the two-step send, plus
// the breaker reset — every one of them a WRITE, and none of them ever retried:
// Beeper has no idempotency key on send, so a client-side retry is a second
// real message to a real person. The server marks these `retryable: false` in
// the error envelope for the same reason; nothing here re-issues a request.
//
// `confirmFirstContact` is passed explicitly and only when the user has
// answered an inline confirmation. It is a gate, not a hint: the server refuses
// the first outbound message to a conversation without it.
export const listOutboxEntries = (conversationId, options = {}) => request(`/beeper/outbox?conversationId=${encodeURIComponent(conversationId)}`, options);
export const createOutboxEntry = (conversationId, body, options = {}) => request('/beeper/outbox', {
  method: 'POST',
  body: JSON.stringify({ conversationId, body }),
  ...options,
});
export const sendOutboxEntry = (id, { confirmFirstContact = false } = {}, options = {}) => request(`/beeper/outbox/${encodeURIComponent(id)}/send`, {
  method: 'POST',
  body: JSON.stringify({ confirmFirstContact }),
  ...options,
});
export const clearOutboxBreaker = (options = {}) => request('/beeper/outbox/breaker/clear', { method: 'POST', ...options });
