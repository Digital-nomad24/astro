import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotFoundError, ValidationError } from '@astro/errors';

import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type {
  IMentorCategoryRepo,
  IMentorProfileRepo,
  IUpdateMentorProfileParams,
} from '../../domain/repos/mentor.repos';
import { MENTOR_CATEGORY_REPO, MENTOR_PROFILE_REPO } from '../../tokens';
import { toMyMentorProfile, type MyMentorProfileResponse } from '../mappers/mentor.mapper';

@Injectable()
export class GetMyMentorProfileUseCase {
  constructor(@Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo) {}

  async execute(user: AuthenticatedUser): Promise<MyMentorProfileResponse> {
    const record = await this.mentors.findByUserId(user.id);
    if (!record) {
      throw new NotFoundError('MENTOR_PROFILE_NOT_FOUND', 'You have not applied as a mentor yet.');
    }
    return toMyMentorProfile(record);
  }
}

export interface UpdateMyMentorProfileParams {
  categorySlug?: string;
  displayName?: string;
  headline?: string | null;
  bio?: string | null;
  languages?: string[];
  experienceYears?: number;
  ratePaisePerMinute?: number;
}

@Injectable()
export class UpdateMyMentorProfileUseCase {
  private readonly logger = new Logger(UpdateMyMentorProfileUseCase.name);

  constructor(
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
    @Inject(MENTOR_CATEGORY_REPO) private readonly categories: IMentorCategoryRepo,
  ) {}

  async execute(
    user: AuthenticatedUser,
    params: UpdateMyMentorProfileParams,
  ): Promise<MyMentorProfileResponse> {
    const existing = await this.mentors.findByUserId(user.id);
    if (!existing) {
      throw new NotFoundError('MENTOR_PROFILE_NOT_FOUND', 'You have not applied as a mentor yet.');
    }

    const patch: IUpdateMentorProfileParams = {
      displayName: params.displayName,
      headline: params.headline,
      bio: params.bio,
      languages: params.languages,
      experienceYears: params.experienceYears,
      ratePaisePerMinute: params.ratePaisePerMinute,
    };

    if (params.categorySlug) {
      const category = await this.categories.findBySlug(params.categorySlug);
      if (!category) {
        throw new NotFoundError(
          'CATEGORY_NOT_FOUND',
          `No category with slug "${params.categorySlug}".`,
        );
      }
      if (!category.isActive) {
        throw new ValidationError('CATEGORY_INACTIVE', 'That category is no longer active.');
      }
      Object.assign(patch, { categoryId: category.id });
    }

    const updated = await this.mentors.update(existing.id, patch);

    // A rate change is worth an audit line of its own: it is the number that gets frozen onto
    // every subsequent Session, and "why was I charged that" is answered from this log.
    if (
      params.ratePaisePerMinute !== undefined &&
      params.ratePaisePerMinute !== existing.ratePaisePerMinute
    ) {
      this.logger.log({
        event: 'mentor.rate_changed',
        mentorProfileId: existing.id,
        fromPaise: existing.ratePaisePerMinute,
        toPaise: params.ratePaisePerMinute,
      });
    }

    return toMyMentorProfile(updated);
  }
}
