import { z } from 'zod';

/**
 * Validated environment. `ConfigModule.forRoot({ validate })` runs this at boot, so a missing
 * or malformed variable fails startup with a readable message instead of surfacing as an
 * undefined at 3am.
 *
 * Read values as `config.get('KEY', { infer: true })` with the service typed
 * `ConfigService<EnvVars, true>` — that is what makes the return type non-optional.
 *
 * Note that `z.object` strips unknown keys, so anything not declared here is invisible to
 * `ConfigService`. Libraries that read `process.env` directly (firebase-admin, Prisma) are
 * unaffected.
 */

/** `true`/`1`/`yes` are all truthy; everything else is false. Env vars are strings. */
const booleanish = (defaultValue: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      if (typeof value === 'boolean') return value;
      return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

export const envSchema = z
  .object({
    // ---- runtime ----
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Cloud Run injects this. Never hardcode a port in `main.ts`. */
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    ENABLE_SWAGGER: booleanish(false),
    /** Comma-separated. Managed in the Cloud Run console, not by the deploy command. */
    CORS_ORIGINS: z.string().optional(),
    WEB_APP_ORIGIN: z.string().url().optional(),

    // ---- datastores ----
    /**
     * Must be a DIRECT (session-mode) Postgres URL. Prisma interactive transactions — which
     * the whole billing ledger depends on — break against a transaction-mode pooler, and they
     * break only under concurrency, i.e. only in production. See the superRefine below.
     */
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    /** Escape hatch for the pooler check, for the rare case where you truly mean it. */
    ALLOW_POOLED_DATABASE_URL: booleanish(false),
    /**
     * Required, unlike the reference repo where Redis was optional with in-memory fallbacks.
     * The queue's correctness properties ARE Redis semantics (ZPOPMIN atomicity, Lua dispatch,
     * ZRANGEBYSCORE expiry); an in-memory stand-in would make local testing prove nothing.
     */
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
    /**
     * Gates only the Socket.IO Redis ADAPTER, not the data plane. Off is safe with a single
     * instance; it must be on for `--max-instances > 1` or a room emit on one instance never
     * reaches sockets on another.
     */
    REDIS_ADAPTER_ENABLED: booleanish(true),

    // ---- auth ----
    FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),
    /**
     * Credential ladder, most specific first. In production all three should be UNSET so
     * firebase-admin falls back to Application Default Credentials — there is deliberately no
     * key material in the image, the repo, or Secret Manager.
     */
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    FIREBASE_ADMIN_CREDENTIALS: z.string().optional(),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
    /**
     * Local-only. firebase-admin honours this and then accepts emulator-issued tokens with no
     * credentials at all — which is what makes the zero-GCP local story work, and also a total
     * auth bypass if it ever reaches production. Guarded below.
     */
    FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
    /** Comma-separated emails bootstrapped to the ADMIN role by the seed. */
    ADMIN_BOOTSTRAP_EMAILS: z.string().optional(),
    /**
     * The PUBLIC Firebase web API key. Not a credential — it ships in every browser bundle.
     * The server needs it only in e2e tests, to exchange an Admin-minted custom token for a
     * real ID token so the guard is exercised against genuine Google-signed JWTs.
     */
    FIREBASE_WEB_API_KEY: z.string().optional(),
    /**
     * How long a resolved identity stays cached in Redis. This is the hot path of every
     * authenticated request, so it exists to avoid a Postgres round trip per call.
     *
     * It is also the worst-case lag for a role change that bypasses the app (a manual SQL
     * UPDATE, or the seed's ADMIN promotion). Writes made through the app invalidate the
     * entry immediately, so keep this short enough that an out-of-band change still settles
     * quickly — minutes, not hours.
     */
    IDENTITY_CACHE_TTL_S: z.coerce.number().int().positive().default(300),

    // ---- LiveKit (voice; used from M4) ----
    LIVEKIT_URL: z.string().optional(),
    LIVEKIT_API_KEY: z.string().optional(),
    LIVEKIT_API_SECRET: z.string().optional(),
    /**
     * Comma-separated, newest first. Defaults to LIVEKIT_API_SECRET. A list so rotating the
     * API secret is not a self-inflicted outage: both verify during the overlap window.
     */
    LIVEKIT_WEBHOOK_SECRETS: z.string().optional(),

    // ---- sessions ----
    SESSION_MAX_DURATION_S: z.coerce.number().int().positive().default(3300),
    RING_TIMEOUT_S: z.coerce.number().int().positive().default(30),
    MEDIA_ESTABLISH_TIMEOUT_S: z.coerce.number().int().positive().default(45),
    SESSION_REJOIN_GRACE_S: z.coerce.number().int().positive().default(15),
    /** A text session with no idle timeout bills forever. This is the only backstop text has. */
    CHAT_IDLE_TIMEOUT_S: z.coerce.number().int().positive().default(300),
    CHAT_SEND_RATE_LIMIT: z.coerce.number().int().positive().default(30),
    CHAT_SEND_RATE_WINDOW_S: z.coerce.number().int().positive().default(60),
    CHAT_HISTORY_PAGE_SIZE: z.coerce.number().int().positive().max(200).default(50),
    CHAT_MESSAGE_MAX_LENGTH: z.coerce.number().int().positive().max(20_000).default(4000),

    // ---- chat retention ----
    /**
     * How long a transcript is kept after the session ends. Once it is both past this age and
     * summarised (M8), the messages are deleted and only the summary survives.
     */
    CHAT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
    /**
     * The backstop, and the reason this is a policy rather than a hope: a transcript is
     * deleted at this age **whether or not a summary was ever produced**. Delete-on-summarise
     * alone leaks transcripts forever whenever the summariser is broken; a backstop alone
     * would hold every transcript for the full window for no reason. Both, as with the audio
     * retention in §7 of the plan.
     *
     * NOTE while M8 is outstanding: nothing can produce a summary yet, so every completed chat
     * reaches this backstop un-summarised. Raise it if M8 slips past a month.
     */
    CHAT_HARD_DELETE_DAYS: z.coerce.number().int().positive().default(30),

    // ---- reviews ----
    /**
     * How long after a consultation ends it can still be rated. Bounded so the aggregate
     * reflects recent service, and so an old session cannot be dredged up to rating-bomb a
     * mentor months later.
     */
    REVIEW_WINDOW_DAYS: z.coerce.number().int().positive().default(30),

    // ---- presence ----
    PRESENCE_HEARTBEAT_S: z.coerce.number().int().positive().default(15),
    PRESENCE_TTL_S: z.coerce.number().int().positive().default(45),

    // ---- queue ----
    QUEUE_MAX_DEPTH: z.coerce.number().int().positive().default(20),
    QUEUE_ENTRY_TTL_S: z.coerce.number().int().positive().default(1800),
    QUEUE_DISCONNECT_GRACE_S: z.coerce.number().int().positive().default(90),
    QUEUE_MENTOR_OFFLINE_GRACE_S: z.coerce.number().int().positive().default(120),
    ETA_DEFAULT_SESSION_S: z.coerce.number().int().positive().default(600),

    // ---- billing (M9) ----
    BILLING_INTERVAL_S: z.coerce.number().int().positive().default(60),
    BILLING_TICK_S: z.coerce.number().int().positive().default(15),
    /** Bounds a catch-up burst so a stalled sweeper cannot drain a wallet in one commit. */
    BILLING_MAX_INTERVALS_PER_TICK: z.coerce.number().int().positive().default(10),
    MIN_SESSION_MINUTES: z.coerce.number().int().positive().default(3),
    PLATFORM_COMMISSION_BPS: z.coerce.number().int().min(0).max(10_000).default(3000),
    PAYMENT_PROVIDER: z.enum(['manual']).default('manual'),
    DEFAULT_CURRENCY: z.string().length(3).default('INR'),

    // ---- infra ----
    /** Cloud Run sets K_REVISION; used to attribute leader-lock ownership and audit logs. */
    K_REVISION: z.string().optional(),
    LEADER_LOCK_TTL_S: z.coerce.number().int().positive().default(30),
  })
  .superRefine((env, ctx) => {
    // The single highest-value check in this file. The emulator does not verify token
    // signatures at all, so this combination accepts any forged token as any user.
    if (env.NODE_ENV === 'production' && env.FIREBASE_AUTH_EMULATOR_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIREBASE_AUTH_EMULATOR_HOST'],
        message:
          'FIREBASE_AUTH_EMULATOR_HOST is set with NODE_ENV=production. The emulator accepts ' +
          'UNSIGNED tokens — this is a total authentication bypass. Refusing to boot.',
      });
    }

    // Prisma's interactive transactions pin a session; a transaction-mode pooler hands the
    // connection to someone else between statements. The ledger's whole atomicity story
    // depends on this being a direct connection.
    if (!env.ALLOW_POOLED_DATABASE_URL) {
      const pooled = detectTransactionPooler(env.DATABASE_URL);
      if (pooled) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message:
            `DATABASE_URL looks like a transaction-mode pooler (${pooled}). Prisma interactive ` +
            'transactions break against one, and only under concurrency — i.e. only in ' +
            'production. Use the direct/session-mode URL, or set ALLOW_POOLED_DATABASE_URL=true ' +
            'if you are certain.',
        });
      }
    }

    // A rider must be reported as stale before their key expires, or presence flickers.
    if (env.PRESENCE_TTL_S <= env.PRESENCE_HEARTBEAT_S) {
      ctx.addIssue({
        code: 'custom',
        path: ['PRESENCE_TTL_S'],
        message:
          `PRESENCE_TTL_S (${env.PRESENCE_TTL_S}) must exceed PRESENCE_HEARTBEAT_S ` +
          `(${env.PRESENCE_HEARTBEAT_S}), ideally by 2-3 heartbeats, or a single dropped ` +
          'heartbeat marks a live mentor offline.',
      });
    }

    // Ticking slower than the billing interval means a session can overrun a whole unbilled
    // interval before anyone notices the balance is gone.
    if (env.BILLING_TICK_S > env.BILLING_INTERVAL_S) {
      ctx.addIssue({
        code: 'custom',
        path: ['BILLING_TICK_S'],
        message:
          `BILLING_TICK_S (${env.BILLING_TICK_S}) must not exceed BILLING_INTERVAL_S ` +
          `(${env.BILLING_INTERVAL_S}), or the cutoff can lag a full interval behind the wallet.`,
      });
    }

    // The backstop must not fire before the normal path has had its chance, or every
    // transcript is deleted un-summarised and the retention window means nothing.
    if (env.CHAT_HARD_DELETE_DAYS < env.CHAT_RETENTION_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['CHAT_HARD_DELETE_DAYS'],
        message:
          `CHAT_HARD_DELETE_DAYS (${env.CHAT_HARD_DELETE_DAYS}) is below CHAT_RETENTION_DAYS ` +
          `(${env.CHAT_RETENTION_DAYS}). The backstop would delete every transcript before it ` +
          'could be summarised, so no summary would ever be produced.',
      });
    }

    if (env.NODE_ENV === 'production') {
      for (const key of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required in production — voice sessions cannot be created without it.`,
          });
        }
      }
      if (!env.REDIS_ADAPTER_ENABLED) {
        ctx.addIssue({
          code: 'custom',
          path: ['REDIS_ADAPTER_ENABLED'],
          message:
            'REDIS_ADAPTER_ENABLED=false in production. Without the Socket.IO Redis adapter, a ' +
            'room emit on one instance never reaches sockets on another, so anything above ' +
            '--max-instances=1 silently drops events.',
        });
      }
    }
  });

export type EnvVars = z.infer<typeof envSchema>;

/**
 * Best-effort detection of a transaction-mode pooler. Recognises the common hosted shapes:
 * Supabase (`:6543`), Neon/Prisma Accelerate style (`-pooler` in the host), and an explicit
 * `pgbouncer=true`. An unparseable URL is left alone — Prisma will complain about it anyway.
 */
function detectTransactionPooler(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.searchParams.get('pgbouncer') === 'true') return 'pgbouncer=true';
  if (parsed.hostname.includes('-pooler')) return `host "${parsed.hostname}"`;
  if (parsed.port === '6543') return 'port 6543';
  return null;
}
