// SPDX-License-Identifier: Apache-2.0

/**
 * A store failure the agent can act on. Its message is safe to show: the server sends it as the tool error.
 * Any other error a store throws is reported only as "the record store is unavailable".
 */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Thrown by a store when another call changed the record between this call's get and its put. */
export class StoreConflictError extends StoreError {
  constructor() {
    super('the record was changed by another call at the same time; call this tool again');
    this.name = 'StoreConflictError';
  }
}
