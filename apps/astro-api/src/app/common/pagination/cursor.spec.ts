import { ValidationError } from '@astro/errors';

import { decodeCursor, encodeCursor, toPage } from './cursor';

describe('keyset cursor', () => {
  it('round-trips a numeric sort value', () => {
    const cursor = { v: 4.5, id: 'mnt_1' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('round-trips a string sort value', () => {
    const cursor = { v: '2026-08-06T00:00:00.000Z', id: 'mnt_1' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is opaque — clients cannot read the sort key out of it', () => {
    const encoded = encodeCursor({ v: 4.5, id: 'mnt_1' });
    expect(encoded).not.toContain('mnt_1');
    expect(encoded).not.toContain('4.5');
  });

  it('is URL-safe, so it survives a query string untouched', () => {
    const encoded = encodeCursor({ v: 'a/b+c=d', id: 'mnt_?&' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  describe('rejects malformed input rather than silently restarting', () => {
    it.each([
      ['not base64 at all', '!!!!'],
      ['base64 of non-JSON', Buffer.from('nonsense').toString('base64url')],
      ['missing id', Buffer.from(JSON.stringify({ v: 1 })).toString('base64url')],
      ['missing v', Buffer.from(JSON.stringify({ id: 'x' })).toString('base64url')],
      ['non-string id', Buffer.from(JSON.stringify({ v: 1, id: 2 })).toString('base64url')],
      ['object v', Buffer.from(JSON.stringify({ v: {}, id: 'x' })).toString('base64url')],
      ['null', Buffer.from('null').toString('base64url')],
    ])('%s', (_label, raw) => {
      expect(() => decodeCursor(raw)).toThrow(ValidationError);
      expect(() => decodeCursor(raw)).toThrow(/malformed/i);
    });
  });
});

describe('toPage', () => {
  const cursorOf = (row: { id: string; score: number }) => ({ v: row.score, id: row.id });
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `id_${i}`, score: 100 - i }));

  it('trims the probe row and emits a cursor when more remain', () => {
    // The repo fetches limit + 1; the extra row is how we know without a COUNT query.
    const page = toPage(rows(4), 3, cursorOf);

    expect(page.items).toHaveLength(3);
    expect(page.items.at(-1)?.id).toBe('id_2');
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor as string)).toEqual({ v: 98, id: 'id_2' });
  });

  it('has no next cursor when the page is exactly full', () => {
    expect(toPage(rows(3), 3, cursorOf).nextCursor).toBeNull();
  });

  it('has no next cursor when short', () => {
    const page = toPage(rows(2), 3, cursorOf);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    expect(toPage([], 3, cursorOf)).toEqual({ items: [], nextCursor: null });
  });

  it('anchors the cursor on the LAST returned row, not the probe row', () => {
    // Anchoring on the probe row would skip it on the next page.
    const page = toPage(rows(4), 3, cursorOf);
    expect(decodeCursor(page.nextCursor as string).id).toBe('id_2');
  });
});
