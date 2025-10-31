import { nanoid } from 'nanoid';

/**
 * Generates a unique identifier with an optional prefix using nanoid library.
 * Uses secure, URL-friendly random string generator.
 * Format: {prefix}{nanoid}
 *
 * @param prefix - Optional prefix for the ID (e.g., 'sess_', 'prod_', 'ssn_')
 *                 Note: Include underscore in prefix if needed
 * @param size - Size of the generated ID (default: 16)
 * @returns A unique string identifier (URL-friendly)
 *
 * @example
 * generateUid() // "V1StGXR8_Z5jdHi6"
 * generateUid('sess_') // "sess_V1StGXR8_Z5jdHi6"
 * generateUid('prod_', 10) // "prod_V1StGXR8_Z"
 * generateUid('ssn_') // "ssn_KcntqSRqbl914woa"
 */
export function generateUid(prefix?: string, size: number = 16): string {
  const id = nanoid(size);
  return prefix ? `${prefix}${id}` : id;
}
