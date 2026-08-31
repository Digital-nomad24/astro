import { envSchema } from './env.schema';

/**
 * These guards are the reason `env.schema.ts` exists rather than a pile of `process.env`
 * reads. Each one encodes a failure that is invisible until production.
 */
describe('envSchema', () => {
  const base = {
    DATABASE_URL: 'postgresql://astro:astro@localhost:5432/astro',
    REDIS_URL: 'redis://localhost:6379',
    FIREBASE_PROJECT_ID: 'astro-local',
  };

  const issuesFor = (env: Record<string, unknown>): string[] => {
    const result = envSchema.safeParse(env);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
  };

  it('accepts a minimal development environment and applies defaults', () => {
    const parsed = envSchema.parse(base);

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.PORT).toBe(3000);
    expect(parsed.BILLING_INTERVAL_S).toBe(60);
    expect(parsed.PLATFORM_COMMISSION_BPS).toBe(3000);
    // booleanish default
    expect(parsed.ENABLE_SWAGGER).toBe(false);
    expect(parsed.REDIS_ADAPTER_ENABLED).toBe(true);
  });

  it('coerces booleanish strings', () => {
    expect(envSchema.parse({ ...base, ENABLE_SWAGGER: 'true' }).ENABLE_SWAGGER).toBe(true);
    expect(envSchema.parse({ ...base, ENABLE_SWAGGER: '1' }).ENABLE_SWAGGER).toBe(true);
    expect(envSchema.parse({ ...base, ENABLE_SWAGGER: 'no' }).ENABLE_SWAGGER).toBe(false);
    expect(envSchema.parse({ ...base, ENABLE_SWAGGER: '' }).ENABLE_SWAGGER).toBe(false);
  });

  describe('the auth-bypass guard', () => {
    it('allows the emulator in development', () => {
      expect(issuesFor({ ...base, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toEqual([]);
    });

    it('refuses to boot with the emulator in production', () => {
      const issues = issuesFor({
        ...base,
        NODE_ENV: 'production',
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
        LIVEKIT_URL: 'wss://x.livekit.cloud',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
      });
      expect(issues).toContain('FIREBASE_AUTH_EMULATOR_HOST');
    });
  });

  describe('the transaction-pooler guard', () => {
    it.each([
      ['postgresql://u:p@db-pooler.example.com:5432/astro', 'a -pooler host'],
      ['postgresql://u:p@db.example.com:6543/astro', 'port 6543'],
      ['postgresql://u:p@db.example.com:5432/astro?pgbouncer=true', 'pgbouncer=true'],
    ])('rejects %s (%s)', (url) => {
      expect(issuesFor({ ...base, DATABASE_URL: url })).toContain('DATABASE_URL');
    });

    it('accepts a direct connection', () => {
      expect(issuesFor(base)).toEqual([]);
    });

    it('can be overridden deliberately', () => {
      const issues = issuesFor({
        ...base,
        DATABASE_URL: 'postgresql://u:p@db.example.com:6543/astro',
        ALLOW_POOLED_DATABASE_URL: 'true',
      });
      expect(issues).toEqual([]);
    });
  });

  describe('cross-field guards', () => {
    it('requires the presence TTL to outlive the heartbeat', () => {
      expect(issuesFor({ ...base, PRESENCE_HEARTBEAT_S: '45', PRESENCE_TTL_S: '45' })).toContain(
        'PRESENCE_TTL_S',
      );
    });

    it('requires the billing tick not to exceed the billing interval', () => {
      expect(issuesFor({ ...base, BILLING_TICK_S: '90', BILLING_INTERVAL_S: '60' })).toContain(
        'BILLING_TICK_S',
      );
    });
  });

  describe('production requirements', () => {
    const prod = { ...base, NODE_ENV: 'production' };

    it('requires LiveKit credentials', () => {
      const issues = issuesFor(prod);
      expect(issues).toEqual(
        expect.arrayContaining(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']),
      );
    });

    it('refuses to disable the Socket.IO Redis adapter', () => {
      const issues = issuesFor({
        ...prod,
        LIVEKIT_URL: 'wss://x.livekit.cloud',
        LIVEKIT_API_KEY: 'k',
        LIVEKIT_API_SECRET: 's',
        REDIS_ADAPTER_ENABLED: 'false',
      });
      expect(issues).toContain('REDIS_ADAPTER_ENABLED');
    });
  });
});
