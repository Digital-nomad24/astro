import { ValidationError } from '@astro/errors';

/**
 * Keyset ("seek") pagination.
 *
 * A cursor carries the sort value of the last row returned plus its id as a tiebreaker, so
 * the next page is a range predicate the index can seek to directly. Two reasons this is not
 * OFFSET:
 *
 *   - OFFSET N makes Postgres walk and discard N rows, so page 50 costs fifty times page 1.
 *   - A mentor going online, being suspended, or gaining a rating between two page fetches
 *     shifts every OFFSET boundary, so users silently skip or re-see rows while scrolling.
 *
 * It is also deliberately NOT Prisma's `cursor:` option, which resolves the anchor row by id
 * before querying: if that mentor is suspended mid-scroll the anchor disappears and pagination
 * breaks. Carrying the sort value in the cursor means the next page is computable without the
 * anchor row still existing.
 *
 * The encoding is opaque on purpose — base64url of JSON, not a raw id. Clients that parse
 * cursors end up depending on the sort key, which then cannot be changed.
 */
export interface PageCursor {
  /** The last row's sort value. */
  readonly v: string | number;
  /** The last row's id, breaking ties so ordering is total and stable. */
  readonly id: string;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Rejects a malformed cursor rather than silently restarting from page one — a client with a
 * corrupted cursor should see an error, not an infinite scroll that quietly loops.
 */
export function decodeCursor(raw: string): PageCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('INVALID_CURSOR', 'The pagination cursor is malformed.');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('v' in parsed) ||
    !('id' in parsed) ||
    typeof (parsed as PageCursor).id !== 'string' ||
    !['string', 'number'].includes(typeof (parsed as PageCursor).v)
  ) {
    throw new ValidationError('INVALID_CURSOR', 'The pagination cursor is malformed.');
  }

  return { v: (parsed as PageCursor).v, id: (parsed as PageCursor).id };
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Null when this is the last page. */
  readonly nextCursor: string | null;
}

/**
 * Builds a page from `limit + 1` rows: the extra row is how we know another page exists
 * without a second COUNT query over the whole filtered set.
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => PageCursor): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null,
  };
}
