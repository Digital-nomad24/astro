import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@astro/errors';
import { BOOKABLE_MENTOR_APPROVAL_STATUS } from '@astro/contracts';

import type { IMentorProfileRepo } from '../../domain/repos/mentor.repos';
import { MENTOR_PROFILE_REPO } from '../../tokens';
import { toMentorDetail, type MentorDetailResponse } from '../mappers/mentor.mapper';

@Injectable()
export class GetMentorUseCase {
  constructor(@Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo) {}

  async execute(mentorProfileId: string): Promise<MentorDetailResponse> {
    const record = await this.mentors.findById(mentorProfileId);

    // A pending, rejected or suspended mentor is 404 rather than 403: whether a particular
    // application exists is not public information, and a 403 would confirm it does.
    if (!record || record.approvalStatus !== BOOKABLE_MENTOR_APPROVAL_STATUS) {
      throw new NotFoundError('MENTOR_NOT_FOUND', 'Mentor not found.');
    }

    return toMentorDetail(record);
  }
}
