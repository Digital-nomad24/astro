/**
 * DI tokens for the sessions domain. Symbols, not strings, so two modules cannot accidentally
 * register providers under the same name.
 */
export const SESSION_REPO = Symbol('SESSION_REPO');
export const WEBHOOK_EVENT_REPO = Symbol('WEBHOOK_EVENT_REPO');
