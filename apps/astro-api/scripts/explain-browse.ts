import 'dotenv/config';
import { Pool } from 'pg';

/**
 * Does the browse query get its ordering from an index, or does Postgres sort?
 *
 * At 200 rows a sequential scan is genuinely optimal, so `enable_seqscan=off` is used to ask
 * the real question: CAN the planner satisfy filter + ORDER BY from one index? The tell is the
 * absence of a `Sort` node — a Sort means the whole filtered set is materialised and ordered
 * on every page request, which is exactly what stops scaling.
 */
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const QUERIES: { label: string; sql: string; params: unknown[] }[] = [
  {
    label: 'browse: category + rating sort (the default screen)',
    sql: `SELECT id FROM "MentorProfile"
          WHERE "approvalStatus"='APPROVED' AND "categoryId"=$1
          ORDER BY "ratingAvg" DESC, "id" DESC LIMIT 21`,
    params: [],
  },
  {
    label: 'browse: category + online only + rating sort',
    sql: `SELECT id FROM "MentorProfile"
          WHERE "approvalStatus"='APPROVED' AND "categoryId"=$1
            AND "presenceState" IN ('ONLINE','BUSY')
          ORDER BY "ratingAvg" DESC, "id" DESC LIMIT 21`,
    params: [],
  },
  {
    label: 'browse: all categories + rating sort',
    sql: `SELECT id FROM "MentorProfile"
          WHERE "approvalStatus"='APPROVED'
          ORDER BY "ratingAvg" DESC, "id" DESC LIMIT 21`,
    params: [],
  },
  {
    label: 'browse: category + price sort',
    sql: `SELECT id FROM "MentorProfile"
          WHERE "approvalStatus"='APPROVED' AND "categoryId"=$1
          ORDER BY "ratePaisePerMinute" ASC, "id" ASC LIMIT 21`,
    params: [],
  },
  {
    label: 'admin: pending moderation queue',
    sql: `SELECT id FROM "MentorProfile"
          WHERE "approvalStatus"='PENDING'
          ORDER BY "createdAt" ASC, "id" ASC LIMIT 21`,
    params: [],
  },
];

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM "MentorCategory" WHERE slug='astrology'`,
    );
    const categoryId = rows[0]?.id;
    if (!categoryId) throw new Error('Seed the database first.');

    // Both are needed to ask the right question. A Bitmap Index Scan NEVER returns rows in
    // index order, so it always implies a Sort — and at 200 rows the planner prefers bitmap
    // regardless of what the index could do. Disabling both forces a plain Index Scan, which
    // is what production will choose once the catalogue is large enough for ordering to matter.
    await client.query('SET enable_seqscan = off');
    await client.query('SET enable_bitmapscan = off');

    for (const query of QUERIES) {
      const params = query.sql.includes('$1') ? [categoryId] : [];
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${query.sql}`,
        params,
      );
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      const sorted = /(^|\s)Sort\b/m.test(text);
      const indexed = /Index (Scan|Only Scan)/.test(text);

      console.log(`\n${query.label}`);
      console.log(`  index scan : ${indexed ? 'yes' : 'NO'}`);
      console.log(`  sort node  : ${sorted ? 'YES  <-- ordering not served by the index' : 'no'}`);
      console.log(
        text
          .split('\n')
          .map((row) => `    ${row}`)
          .join('\n'),
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
