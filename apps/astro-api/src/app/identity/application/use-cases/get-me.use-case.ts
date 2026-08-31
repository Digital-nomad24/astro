import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@astro/errors';

import type { IAuthUserRepo } from '../../domain/repos/auth-user.repo.interface';
import { AUTH_USER_REPO } from '../../tokens';
import { toMeResponse, type MeResponse } from '../mappers/me.mapper';

@Injectable()
export class GetMeUseCase {
  constructor(@Inject(AUTH_USER_REPO) private readonly authUsers: IAuthUserRepo) {}

  /**
   * Reads through to Postgres rather than returning the guard's cached identity: the cache
   * holds only what authorization needs, and this is the endpoint a client calls precisely
   * when it wants the current, complete profile.
   */
  async execute(firebaseUid: string): Promise<MeResponse> {
    const record = await this.authUsers.findByFirebaseUid(firebaseUid);
    if (!record) {
      // The guard provisions on the way in, so reaching this means the row was deleted
      // mid-request — real, but rare enough that a 404 is the honest answer.
      throw new NotFoundError('USER_NOT_FOUND', 'Your account no longer exists.');
    }
    return toMeResponse(record);
  }
}
