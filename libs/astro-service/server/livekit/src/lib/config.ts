/**
 * Configuration surface for LiveKit Cloud.
 */
export interface LiveKitConfig {
  /** e.g. `wss://<project>.livekit.cloud`, or `ws://localhost:7880` against `--dev`. */
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  /**
   * Credential pairs accepted when verifying inbound webhook signatures, newest first.
   *
   * A **list of pairs**, not a list of bare secrets. The webhook signature is a JWT whose
   * `iss` claim is the API key, and `TokenVerifier` checks `iss` as well as the signature —
   * so a secret without its matching key verifies nothing. Rotating on LiveKit Cloud issues
   * a new key *and* secret, and accepting only the new pair would reject every webhook still
   * in flight under the old one. Defaults to `[{ apiKey, apiSecret }]`.
   */
  readonly webhookCredentials: readonly LiveKitCredential[];
}

export interface LiveKitCredential {
  readonly apiKey: string;
  readonly apiSecret: string;
}

/**
 * The server API speaks HTTP, not WebSocket, but `LIVEKIT_URL` is the client-facing `wss://`
 * URL because that is the one LiveKit's console shows and the one the browser SDK needs.
 * Handing `wss://…` straight to `RoomServiceClient` produces a fetch that fails with an
 * unhelpful protocol error, so the swap happens here rather than in every caller.
 */
export function httpUrlFromLiveKitUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`;
  return trimmed;
}

/**
 * Parses `LIVEKIT_WEBHOOK_SECRETS` into verifiable credential pairs.
 *
 * Two accepted entry shapes, because rotation happens in two shapes:
 *
 * - `APIkey:secret` — a full pair, which is what a LiveKit Cloud key rotation gives you.
 * - `secret` — a bare secret, paired with the primary `apiKey`. This covers rotating only
 *   the secret under a stable key, and keeps the common single-credential case a one-value
 *   env var instead of a colon-joined pair repeated from `LIVEKIT_API_KEY`.
 *
 * The primary pair is always included and always tried first, so an empty or malformed
 * value degrades to "verify with the configured credentials" rather than to "verify
 * nothing" — a webhook path that silently accepts everything is worse than one that
 * rejects a rotated key.
 */
export function parseWebhookCredentials(
  primary: LiveKitCredential,
  raw: string | undefined,
): LiveKitCredential[] {
  const credentials: LiveKitCredential[] = [primary];
  const seen = new Set([`${primary.apiKey}:${primary.apiSecret}`]);

  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Only the FIRST colon separates key from secret — a secret may itself contain colons.
    const separatorAt = trimmed.indexOf(':');
    const candidate: LiveKitCredential =
      separatorAt > 0
        ? {
            apiKey: trimmed.slice(0, separatorAt),
            apiSecret: trimmed.slice(separatorAt + 1),
          }
        : { apiKey: primary.apiKey, apiSecret: trimmed };

    if (!candidate.apiKey || !candidate.apiSecret) continue;

    const key = `${candidate.apiKey}:${candidate.apiSecret}`;
    if (seen.has(key)) continue;
    seen.add(key);
    credentials.push(candidate);
  }

  return credentials;
}
