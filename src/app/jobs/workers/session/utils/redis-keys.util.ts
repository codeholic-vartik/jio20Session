/**
 * @fileoverview Redis key utility functions for session worker
 * @description Provides functions to generate consistent Redis key patterns
 */

/**
 * Generates Redis key for tracking session creation status
 *
 * @description
 * Creates a standardized Redis key to track the status of session creation
 * when a threshold is reached. The key stores metadata about the creation
 * process including status, timestamps, and error information.
 *
 * @param {number} sessionProfileId - The session profile ID
 * @param {number} sessionId - The session ID that triggered the creation
 * @returns {string} Redis key in format: `session:creation:pending:{profileId}:{sessionId}`
 *
 * @example
 * ```typescript
 * const key = getSessionCreationKey(123, 456);
 * // Returns: "session:creation:pending:123:456"
 *
 * // Store creation status
 * await redis.setex(key, 3600, JSON.stringify({
 *   isCreated: false,
 *   timestamp: new Date().toISOString(),
 *   sessionId: 456,
 *   sessionProfileId: 123
 * }));
 * ```
 */
export const getSessionCreationKey = (
  sessionProfileId: number,
  sessionId: number,
): string => `session:creation:pending:${sessionProfileId}:${sessionId}`;
