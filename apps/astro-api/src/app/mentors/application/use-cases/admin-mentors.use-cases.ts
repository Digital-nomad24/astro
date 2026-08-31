import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError } from '@astro/errors';
import type { MentorApprovalStatus } from '@astro/contracts';

import { decodeCursor, toPage, type Page } from '../../../common/pagination/cursor';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type { IMentorCategoryRepo, IMentorProfileRepo } from '../../domain/repos/mentor.repos';
import { MENTOR_CATEGORY_REPO, MENTOR_PROFILE_REPO } from '../../tokens';
import {
  toMentorCategory,
  toMyMentorProfile,
  type MentorCategoryResponse,
  type MyMentorProfileResponse,
} from '../mappers/mentor.mapper';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

@Injectable()
export class ListMentorApplicationsUseCase {
  constructor(@Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo) {}

  async execute(params: {
    status?: MentorApprovalStatus;
    limit?: number;
    cursor?: string;
  }): Promise<Page<MyMentorProfileResponse>> {
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const rows = await this.mentors.listByApprovalStatus(
      params.status ?? 'PENDING',
      limit,
      params.cursor ? decodeCursor(params.cursor) : null,
    );

    const page = toPage(rows, limit, (row) => ({ v: row.createdAt.toISOString(), id: row.id }));
    return { items: page.items.map(toMyMentorProfile), nextCursor: page.nextCursor };
  }
}

@Injectable()
export class ReviewMentorApplicationUseCase {
  private readonly logger = new Logger(ReviewMentorApplicationUseCase.name);

  constructor(@Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo) {}

  /**
   * Approve, reject or suspend. This is the single gate between an application and a mentor
   * appearing in the catalogue, so it is deliberately one auditable operation rather than
   * three endpoints that each set a status.
   */
  async execute(
    admin: AuthenticatedUser,
    mentorProfileId: string,
    status: MentorApprovalStatus,
    note: string | null,
  ): Promise<MyMentorProfileResponse> {
    if (status === 'PENDING') {
      throw new ValidationError(
        'INVALID_REVIEW_STATUS',
        'A review must resolve to APPROVED, REJECTED or SUSPENDED.',
      );
    }

    const existing = await this.mentors.findById(mentorProfileId);
    if (!existing) {
      throw new NotFoundError('MENTOR_NOT_FOUND', 'Mentor application not found.');
    }
    if (existing.approvalStatus === status) {
      throw new ConflictError('ALREADY_IN_STATUS', `This mentor is already ${status}.`);
    }
    // Rejection is for applications; suspension is for mentors already let in. Conflating them
    // would lose the distinction between "never approved" and "approved then withdrawn".
    if (status === 'REJECTED' && existing.approvalStatus === 'APPROVED') {
      throw new ValidationError(
        'USE_SUSPEND_INSTEAD',
        'Suspend an approved mentor rather than rejecting them.',
      );
    }

    const updated = await this.mentors.reviewApplication({
      mentorProfileId,
      status,
      note,
      reviewedByUserId: admin.id,
    });

    this.logger.log({
      event: 'mentor.application_reviewed',
      mentorProfileId,
      fromStatus: existing.approvalStatus,
      toStatus: status,
      reviewedByUserId: admin.id,
    });

    return toMyMentorProfile(updated);
  }
}

@Injectable()
export class ListMentorCategoriesUseCase {
  constructor(@Inject(MENTOR_CATEGORY_REPO) private readonly categories: IMentorCategoryRepo) {}

  async execute(): Promise<MentorCategoryResponse[]> {
    const rows = await this.categories.listActive();
    return rows.map(toMentorCategory);
  }
}

export interface CreateMentorCategoryParams {
  slug: string;
  name: string;
  description?: string;
  iconUrl?: string;
  sortOrder?: number;
}

@Injectable()
export class CreateMentorCategoryUseCase {
  constructor(@Inject(MENTOR_CATEGORY_REPO) private readonly categories: IMentorCategoryRepo) {}

  async execute(params: CreateMentorCategoryParams): Promise<MentorCategoryResponse> {
    const existing = await this.categories.findBySlug(params.slug);
    if (existing) {
      throw new ConflictError(
        'CATEGORY_SLUG_TAKEN',
        `A category with slug "${params.slug}" exists.`,
      );
    }

    const created = await this.categories.create({
      slug: params.slug,
      name: params.name,
      description: params.description ?? null,
      iconUrl: params.iconUrl ?? null,
      sortOrder: params.sortOrder ?? 0,
      isActive: true,
    });
    return toMentorCategory(created);
  }
}

@Injectable()
export class UpdateMentorCategoryUseCase {
  constructor(@Inject(MENTOR_CATEGORY_REPO) private readonly categories: IMentorCategoryRepo) {}

  async execute(
    id: string,
    params: {
      name?: string;
      description?: string | null;
      iconUrl?: string | null;
      sortOrder?: number;
      isActive?: boolean;
    },
  ): Promise<MentorCategoryResponse> {
    const existing = await this.categories.findById(id);
    if (!existing) throw new NotFoundError('CATEGORY_NOT_FOUND', 'Category not found.');

    // The slug is intentionally not updatable: it is in saved links and client-side filters,
    // and renaming it silently breaks both. Retire the category and create a new one instead.
    return toMentorCategory(await this.categories.update(id, params));
  }
}
