/**
 * Strips credential fragments from a string before it is written to a log.
 * Handles Bearer tokens, Authorization headers, SNOW_* env var assignments,
 * and Redis URLs that may contain embedded user:password credentials.
 */
export function redactSecrets(message: string): string {
  // NOTE: Redis URLs may carry user:password@ — scrub before logging.
  const redisUrlPattern = /rediss?:\/\/[^@\s]*@/gi;
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/authorization:\s*\S+/gi, 'authorization: [REDACTED]')
    .replace(/SNOW_[A-Z_]+=\S+/g, 'SNOW_*=[REDACTED]')
    .replace(redisUrlPattern, 'redis://[REDACTED]@');
}
