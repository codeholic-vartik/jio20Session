/**
 * @fileoverview Session utility functions
 * @description Provides helper functions for session-related calculations and parsing
 */

/**
 * Calculates session end time based on duration from profile
 *
 * @description
 * Calculates the end time of a session by adding the duration to the start time.
 * Supports: seconds, minutes, hours, days, years (both singular and plural, case-insensitive)
 *
 * @param {Date} startTime - Session start time
 * @param {number | null} durationValue - Duration value (e.g., 2 for 2 hours)
 * @param {string | null} durationUnit - Duration unit: 'seconds', 'minutes', 'hours', 'days', or 'years'
 * @returns {Date | null} Calculated end time, or null if invalid inputs
 *
 * @example
 * ```typescript
 * const startTime = new Date('2024-01-01T10:00:00Z');
 * const endTime = calculateEndTime(startTime, 2, 'hours');
 * // Returns: Date('2024-01-01T12:00:00Z')
 *
 * const endTime = calculateEndTime(startTime, 30, 'minutes');
 * // Returns: Date('2024-01-01T10:30:00Z')
 * ```
 */
export function calculateEndTime(
  startTime: Date,
  durationValue: number | null,
  durationUnit: string | null,
): Date | null {
  if (!durationValue || !durationUnit) {
    return null;
  }

  const endTime = new Date(startTime);
  // Normalize unit: handle both singular and plural, case-insensitive
  const unit = durationUnit.toLowerCase().trim();

  switch (unit) {
    case 'seconds':
    case 'second':
      endTime.setSeconds(endTime.getSeconds() + durationValue);
      break;
    case 'minutes':
    case 'minute':
      endTime.setMinutes(endTime.getMinutes() + durationValue);
      break;
    case 'hours':
    case 'hour':
      endTime.setHours(endTime.getHours() + durationValue);
      break;
    case 'days':
    case 'day':
      endTime.setDate(endTime.getDate() + durationValue);
      break;
    case 'years':
    case 'year':
      endTime.setFullYear(endTime.getFullYear() + durationValue);
      break;
    default:
      return null;
  }
  return endTime;
}

/**
 * Parses session ID from string or number format
 *
 * @description
 * Handles both numeric and string session IDs. If string format contains
 * prefix like "sess_123", it extracts the numeric part.
 *
 * @param {number | string} sessionId - Session ID in string or number format
 * @returns {number} Parsed numeric session ID
 *
 * @example
 * ```typescript
 * parseSessionId(123) // Returns: 123
 * parseSessionId("456") // Returns: 456
 * parseSessionId("sess_789") // Returns: 789
 * ```
 */
export function parseSessionId(sessionId: number | string): number {
  if (typeof sessionId === 'string') {
    return parseInt(String(sessionId).replace(/^sess_/, ''), 10);
  }
  return Number(sessionId);
}

/**
 * Parses session profile ID from string or number format
 *
 * @description
 * Handles both numeric and string session profile IDs. If string format contains
 * prefix like "prod_123", it extracts the numeric part.
 *
 * @param {number | string} sessionProfileId - Session profile ID in string or number format
 * @returns {number} Parsed numeric session profile ID
 *
 * @example
 * ```typescript
 * parseSessionProfileId(123) // Returns: 123
 * parseSessionProfileId("456") // Returns: 456
 * parseSessionProfileId("prod_789") // Returns: 789
 * ```
 */
export function parseSessionProfileId(
  sessionProfileId: number | string,
): number {
  if (typeof sessionProfileId === 'string') {
    return parseInt(String(sessionProfileId).replace(/^prod_/, ''), 10);
  }
  return Number(sessionProfileId);
}
