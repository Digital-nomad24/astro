import { Inject, Injectable, Logger } from '@nestjs/common';

import type { AuthenticatedUser } from '../../contracts/authenticated-user';
import type { IAuthUserRepo } from '../../domain/repos/auth-user.repo.interface';
import { AUTH_USER_REPO } from '../../tokens';
import { IdentityResolutionService } from '../services/identity-resolution.service';
import { toMeResponse, type MeResponse } from '../mappers/me.mapper';

export interface UpdateMeParams {
  displayName?: string;
  photoUrl?: string | null;
}

@Injectable()
export class UpdateMeUseCase {
  private readonly logger = new Logger(UpdateMeUseCase.name);

  constructor(
    @Inject(AUTH_USER_REPO) private readonly authUsers: IAuthUserRepo,
    private readonly identity: IdentityResolutionService,
  ) {}

  /**
   * Updating the profile is also what completes onboarding: a display name is the one thing
   * required before a user can transact, so setting it stamps `onboardedAt`. That keeps
   * clients from having to call a second "finish onboarding" endpoint and getting stuck
   * halfway when they forget.
   */
  async execute(user: AuthenticatedUser, params: UpdateMeParams): Promise<MeResponse> {
    let record = await this.authUsers.updateProfile(user.id, params);

    const shouldStamp = !record.onboardedAt && Boolean(record.displayName?.trim());
    if (shouldStamp) {
      record = await this.authUsers.markOnboarded(user.id);
      this.logger.log({ event: 'identity.onboarded', userId: record.id });
    }

    // The cached identity carries `onboardedAt`, which `@RequireOnboarded()` gates on. Without
    // this, a user who just completed onboarding would keep getting 403s until the TTL expired.
    await this.identity.invalidate(user.firebaseUid);

    return toMeResponse(record);
  }
}
