import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 config. The datasource URL lives here rather than in `schema.prisma` because the
 * runtime uses the pg driver adapter — the schema's `datasource` block only needs a provider.
 *
 * `schema` points at a DIRECTORY: one model per file under `prisma/models/`, which keeps a
 * schema that will grow to ~15 models reviewable.
 */
export default defineConfig({
  schema: 'prisma/models/',
  migrations: {
    path: 'prisma/migrations',
    seed: 'npm run db:seed',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
