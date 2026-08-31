import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError } from '@astro/errors';

import { PrismaService } from 'prisma/prisma.service';
import { IdentityResolutionService } from '../../../identity/application/services/identity-resolution.service';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type { IMentorCategoryRepo, IMentorProfileRepo } from '../../domain/repos/mentor.repos';
import { MENTOR_CATEGORY_REPO, MENTOR_PROFILE_REPO } from '../../tokens';
import { toMyMentorProfile, type MyMentorProfileResponse } from '../mappers/mentor.mapper';

export interface ApplyAsMentorParams {
  categorySlug: string;
  displayName: string;
  headline?: string;
  bio?: string;
  languages: string[];
  experienceYears: number;
  ratePaisePerMinute: number;
}

@Injectable()
export class ApplyAsMentorUseCase {
  private readonly logger = new Logger(ApplyAsMentorUseCase.name);

  constructor(
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
    @Inject(MENTOR_CATEGORY_REPO) private readonly categories: IMentorCategoryRepo,
    private readonly prisma: PrismaService,
    private readonly identity: IdentityResolutionService,
  ) {}

  /**
   * Applying makes the account a MENTOR immediately but NOT bookable: the role unlocks the
   * mentor-side endpoints (their own profile, later their dashboard), while `approvalStatus`
   * stays PENDING and keeps them out of the catalogue until an admin acts.
   *
   * Those two things are separate on purpose. Collapsing them would mean either an unvetted
   * mentor is instantly bookable, or an applicant cannot see their own application.
   */
  async execute(
    user: AuthenticatedUser,
    params: ApplyAsMentorParams,
  ): Promise<MyMentorProfileResponse> {
    const existing = await this.mentors.findByUserId(user.id);
    if (existing) {
      throw new ConflictError(
        'MENTOR_PROFILE_EXISTS',
        'You have already applied. Check your application status instead.',
      );
    }

    const category = await this.categories.findBySlug(params.categorySlug);
    if (!category) {
      throw new NotFoundError(
        'CATEGORY_NOT_FOUND',
        `No category with slug "${params.categorySlug}".`,
      );
    }
    if (!category.isActive) {
      throw new ValidationError(
        'CATEGORY_INACTIVE',
        'That category is no longer accepting new mentors.',
      );
    }

    // One transaction: a profile without the role would leave the applicant unable to see
    // their own application, and the role without a profile would be a mentor with nothing
    // to moderate.
    const record = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { role: 'MENTOR' } });

      const created = await tx.mentorProfile.create({
        data: {
          userId: user.id,
          categoryId: category.id,
          displayName: params.displayName,
          headline: params.headline ?? null,
          bio: params.bio ?? null,
          languages: params.languages,
          experienceYears: params.experienceYears,
          ratePaisePerMinute: params.ratePaisePerMinute,
        },
        include: { category: { select: { slug: true, name: true } } },
      });
      return created;
    });

    // The cached identity carries the role the guard authorizes on. Without this the new
    // mentor would get 403s from every @Roles('MENTOR') route until the TTL expired.
    await this.identity.invalidate(user.firebaseUid);

    this.logger.log({
      event: 'mentor.applied',
      userId: user.id,
      mentorProfileId: record.id,
      categorySlug: category.slug,
    });

    return toMyMentorProfile({
      ...record,
      categorySlug: record.category.slug,
      categoryName: record.category.name,
    });
  }
}
