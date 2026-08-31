/**
 * Postgres 23505 surfaces from Prisma as P2002.
 *
 * Matched structurally rather than with `instanceof PrismaClientKnownRequestError`, because
 * that class lives behind the generated-client path and an `instanceof` across two copies of
 * the module silently returns false — which would turn a designed race-loser into a 500.
 *
 * This is a load-bearing check, not error handling: the partial unique indexes are the actual
 * mutual exclusion in this system, so "someone else won" arrives here as an exception on the
 * normal path.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
