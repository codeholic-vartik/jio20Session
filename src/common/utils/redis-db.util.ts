interface ResolveRedisDbOptions {
  /**
   * Ordered list of environment variable names to check for a Redis DB index.
   * The first variable with a numeric value wins.
   */
  envNames?: string[];

  /**
   * Fallback Redis DB index if nothing else is specified.
   */
  defaultDb?: number;
}

/**
 * Resolve the Redis database index from environment variables or connection URL.
 *
 * Priority order:
 * 1. First numeric value present in the provided envNames list (defaults to REDIS_DB)
 * 2. Numeric path component in the URL (e.g. redis://host:port/1)
 * 3. "db" query parameter in the URL (e.g. redis://host:port?db=1)
 * 4. Provided defaultDb (defaults to 0)
 *
 * @param url Normalized Redis connection URL.
 * @param options Optional configuration for environment variables and default index.
 */
export function resolveRedisDbIndex(
  url: string,
  options: ResolveRedisDbOptions = {},
): number {
  const { envNames = ['REDIS_DB'], defaultDb = 0 } = options;

  for (const envName of envNames) {
    if (!envName) continue;
    const candidate = process.env[envName];
    if (candidate && /^\d+$/.test(candidate)) {
      return Number(candidate);
    }
  }

  try {
    const parsedUrl = new URL(url);

    if (parsedUrl.pathname && parsedUrl.pathname.length > 1) {
      const pathDb = Number(parsedUrl.pathname.slice(1));
      if (!Number.isNaN(pathDb)) {
        return pathDb;
      }
    }

    const queryDb = parsedUrl.searchParams.get('db');
    if (queryDb && /^\d+$/.test(queryDb)) {
      return Number(queryDb);
    }
  } catch {
    // Ignore URL parsing errors and fall through to default
  }

  return defaultDb;
}
