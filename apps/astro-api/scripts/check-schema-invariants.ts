/**
 * Prints the hand-written schema objects — partial indexes and CHECK constraints — that
 * Prisma cannot express and therefore cannot protect. Run it after any migration.
 *
 *   npm run db:check-invariants
 */
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: `${__dirname}/../.env` });

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const indexes = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND indexdef LIKE '%WHERE%'
     ORDER BY indexname`,
  );

  const checks = await client.query<{ conname: string; def: string; table: string }>(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def, t.relname AS table
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.contype = 'c' AND n.nspname = 'public'
     ORDER BY t.relname, c.conname`,
  );

  console.log('\n=== PARTIAL INDEXES ===');
  for (const row of indexes.rows) console.log(`  ${row.indexname}\n    ${row.indexdef}`);

  console.log('\n=== CHECK CONSTRAINTS ===');
  for (const row of checks.rows) console.log(`  ${row.table}.${row.conname}  ${row.def}`);

  await client.end();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
