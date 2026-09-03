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
