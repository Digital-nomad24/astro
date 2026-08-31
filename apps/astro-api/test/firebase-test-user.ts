const IDENTITY_TOOLKIT = 'https://identitytoolkit.googleapis.com/v1/accounts';

/**
 * Real Firebase users for e2e tests.
 *
 * Deliberately NOT a mocked guard: the point of these tests is that a genuine RS256 token from
 * Google is verified, resolved to a Postgres row, and authorized on. Stubbing the guard would
 * test the mock.
 *
 * Uses only the public Identity Toolkit REST API — sign up to create, and `accounts:delete`
 * with the user's own ID token to remove. No Admin SDK, for two reasons:
 *
 *   - Privileged Admin calls need an OAuth2 access-token exchange, and gaxios fails inside
 *     Jest's sandboxed module registry ("Unexpected Gaxios Error") even though the exact same
 *     call succeeds outside it.
 *   - It keeps the suite runnable on a machine with no service account at all, which is the
 *     posture production uses anyway.
 */
export interface TestUser {
  readonly uid: string;
  readonly email: string;
  readonly idToken: string;
}

const created: TestUser[] = [];

function apiKey(): string {
  const key = process.env.FIREBASE_WEB_API_KEY;
  if (!key) {
    throw new Error(
      'FIREBASE_WEB_API_KEY is required for e2e tests. It is the PUBLIC web API key from the ' +
        'Firebase console — it ships in every browser bundle and is not a credential.',
    );
  }
  return key;
}

async function identityToolkit<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${IDENTITY_TOOLKIT}:${method}?key=${apiKey()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`Identity Toolkit ${method} failed (${res.status}): ${json.error?.message}`);
  }
  return json;
}

export async function createTestUser(label: string): Promise<TestUser> {
  const email = `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.invalid`;
  // Long and random: these accounts are real, and a weak shared password on a real project is
  // a real weakness even for throwaway users.
  const password = `E2e!${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

  const signUp = await identityToolkit<{ idToken: string; localId: string }>('signUp', {
    email,
    password,
    returnSecureToken: true,
  });

  const user: TestUser = { uid: signUp.localId, email, idToken: signUp.idToken };
  created.push(user);
  return user;
}

/** Best-effort teardown — a leaked test user is noise, not a reason to fail the run. */
export async function cleanupTestUsers(): Promise<void> {
  await Promise.allSettled(
    created.map((user) => identityToolkit('delete', { idToken: user.idToken })),
  );
  created.length = 0;
}
