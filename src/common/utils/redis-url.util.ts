/**
 * Normalizes Redis connection strings coming from environment variables.
 *
 * Handles common misconfigurations such as:
 * - Leading slashes (e.g. `//localhost:6379`)
 * - Injected key/value pairs (`redis_url=redis://...`)
 * - Missing scheme (`localhost:6379`)
 * - Embedded credentials without scheme (`default:pass@localhost:6379`)
 *
 * @param rawUrl Raw Redis connection string from configuration/environment
 * @returns Sanitized Redis URL with a valid scheme
 */
export function normalizeRedisUrl(rawUrl: string | undefined | null): string {
  const DEFAULT_URL = 'redis://localhost:6379';

  if (!rawUrl) {
    return DEFAULT_URL;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return DEFAULT_URL;
  }

  // Remove whitespace inside the URL (e.g. accidental newlines/spaces)
  const compact = /\s/.test(trimmed) ? trimmed.replace(/\s+/g, '') : trimmed;

  // Extract the value after the last "=" if the string looks like a key/value assignment
  const candidate =
    compact.includes('=') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(compact)
      ? compact.substring(compact.lastIndexOf('=') + 1)
      : compact;

  // Remove any leading slashes introduced by copy/paste (e.g. //localhost:6379)
  const withoutLeadingSlashes = candidate.replace(/^\/+/, '');

  // If the string already has a scheme (redis:// or rediss://), trust it after cleanup
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(withoutLeadingSlashes)) {
    return withoutLeadingSlashes;
  }

  // Allow credentials without scheme, e.g. default:pass@host:port
  if (/^[^:@]+:[^@]+@[\w.-]+(:\d+)?$/.test(withoutLeadingSlashes)) {
    return `redis://${withoutLeadingSlashes}`;
  }

  // Allow host[:port] values without scheme
  if (/^[\w.-]+(:\d+)?$/.test(withoutLeadingSlashes)) {
    return `redis://${withoutLeadingSlashes}`;
  }

  // Fallback to default if the string is still unusable
  return DEFAULT_URL;
}
