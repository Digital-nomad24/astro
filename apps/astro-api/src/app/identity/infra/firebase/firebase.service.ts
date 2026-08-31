import { readFileSync } from 'node:fs';

import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import type { DecodedIdToken } from 'firebase-admin/auth';

import type { EnvVars } from '../../../../config/env.schema';

type ServiceAccountJson = admin.ServiceAccount & {
  project_id?: string;
  client_email?: string;
};

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);

  /**
   * True when a service-account credential was supplied. Verifying ID tokens does NOT need
   * one; privileged Admin operations (getUser, createCustomToken, setCustomUserClaims) do.
   * Nothing in M1 requires them, so this exists so a future caller can fail loudly rather
   * than mysteriously.
   */
  private privileged = false;

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  onModuleInit(): void {
    if (admin.apps.length > 0) {
      this.logger.warn('Firebase Admin already initialized; skipping re-init');
      return;
    }

    const projectId = this.config.get('FIREBASE_PROJECT_ID', { infer: true }).trim();
    const serviceAccount = this.loadServiceAccount();

    if (serviceAccount) {
      const credentialProjectId = pick(serviceAccount.projectId, serviceAccount.project_id);
      // A key for the wrong project verifies nothing and fails in a confusing way later.
      if (credentialProjectId && credentialProjectId !== projectId) {
        throw new Error(
          `FIREBASE_PROJECT_ID (${projectId}) does not match the service account project ` +
            `(${credentialProjectId}). Use a key for the same project, or fix the env.`,
        );
      }
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId });
      this.privileged = true;
      this.logger.log(
        `Firebase Admin initialized with a service account (project: ${projectId}, ` +
          `client: ${pick(serviceAccount.clientEmail, serviceAccount.client_email) ?? 'unknown'})`,
      );
      return;
    }

    const adc = this.loadApplicationDefault();
    if (adc) {
      admin.initializeApp({ credential: adc, projectId });
      this.privileged = true;
      this.logger.log(`Firebase Admin initialized with ADC (project: ${projectId})`);
      return;
    }

    // Verification-only mode. `verifyIdToken` validates a signature against Google's PUBLIC
    // signing certs and checks `aud` against the project id — neither step needs a
    // credential. This is what lets a clean checkout authenticate real users with no key
    // file and no `gcloud auth application-default login`.
    admin.initializeApp({ projectId });
    this.privileged = false;
    this.logger.warn(
      `Firebase Admin initialized WITHOUT credentials (project: ${projectId}). ID token ` +
        'verification works; privileged Admin operations do not. On Cloud Run this means ADC ' +
        'is not reachable, which is worth investigating.',
    );
  }

  /** Throws on a missing, malformed, expired or wrongly-signed token. */
  verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    return admin.auth().verifyIdToken(idToken);
  }

  /** Guard for the privileged Admin surface, so callers get a clear error, not a 500. */
  assertPrivileged(operation: string): void {
    if (!this.privileged) {
      throw new Error(
        `${operation} needs Firebase Admin credentials, but the app started in ` +
          'verification-only mode. Supply FIREBASE_SERVICE_ACCOUNT_JSON or configure ADC.',
      );
    }
  }

  /**
   * Credential ladder, most explicit first. Returns null when none is configured — that is a
   * supported mode, not an error.
   */
  private loadServiceAccount(): ServiceAccountJson | null {
    const inlineJson = this.config.get('FIREBASE_SERVICE_ACCOUNT_JSON', { infer: true })?.trim();
    if (inlineJson) {
      try {
        return JSON.parse(inlineJson) as ServiceAccountJson;
      } catch (err) {
        throw new Error(
          `FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${asMessage(err)}. It must be the ` +
            'whole key file on one line.',
        );
      }
    }

    const path =
      this.config.get('FIREBASE_ADMIN_CREDENTIALS', { infer: true })?.trim() ||
      this.config.get('GOOGLE_APPLICATION_CREDENTIALS', { infer: true })?.trim();
    if (!path) return null;

    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ServiceAccountJson;
    } catch (err) {
      // Configured-but-broken is a real error: the operator meant to use this.
      throw new Error(`Failed to read the Firebase service account at ${path}: ${asMessage(err)}`);
    }
  }

  private loadApplicationDefault(): admin.credential.Credential | null {
    try {
      return admin.credential.applicationDefault();
    } catch {
      // No ADC on this machine. Expected locally; fall through to verification-only.
      return null;
    }
  }
}

const pick = (...values: (string | undefined)[]): string | undefined =>
  values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
