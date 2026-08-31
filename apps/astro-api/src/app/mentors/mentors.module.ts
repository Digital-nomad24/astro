import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import {
  CreateMentorCategoryUseCase,
  ListMentorApplicationsUseCase,
  ListMentorCategoriesUseCase,
  ReviewMentorApplicationUseCase,
  UpdateMentorCategoryUseCase,
} from './application/use-cases/admin-mentors.use-cases';
import { ApplyAsMentorUseCase } from './application/use-cases/apply-as-mentor.use-case';
import { GetMentorUseCase } from './application/use-cases/get-mentor.use-case';
import { ListMentorsUseCase } from './application/use-cases/list-mentors.use-case';
import {
  GetMyMentorProfileUseCase,
  UpdateMyMentorProfileUseCase,
} from './application/use-cases/my-mentor-profile.use-cases';
import { AdminMentorsController } from './entry-points/http/admin-mentors.controller';
import { MentorsController } from './entry-points/http/mentors.controller';
import { MentorCategoryPrismaRepo } from './infra/db/prisma/repos/mentor-category.prisma.repo';
import { MentorProfilePrismaRepo } from './infra/db/prisma/repos/mentor-profile.prisma.repo';
import { MENTOR_CATEGORY_REPO, MENTOR_PROFILE_REPO } from './tokens';

@Module({
  // For IdentityResolutionService: applying as a mentor changes the role the guard caches, so
  // the cached identity has to be invalidated in the same flow.
  imports: [IdentityModule],
  controllers: [MentorsController, AdminMentorsController],
  providers: [
    ListMentorsUseCase,
    GetMentorUseCase,
    ApplyAsMentorUseCase,
    GetMyMentorProfileUseCase,
    UpdateMyMentorProfileUseCase,
    ListMentorApplicationsUseCase,
    ReviewMentorApplicationUseCase,
    ListMentorCategoriesUseCase,
    CreateMentorCategoryUseCase,
    UpdateMentorCategoryUseCase,
    { provide: MENTOR_CATEGORY_REPO, useClass: MentorCategoryPrismaRepo },
    { provide: MENTOR_PROFILE_REPO, useClass: MentorProfilePrismaRepo },
  ],
  // Exported for the presence (M3), session (M4) and queue (M6) modules, which read mentor
  // state through this port rather than reaching for Prisma themselves.
  exports: [MENTOR_PROFILE_REPO, MENTOR_CATEGORY_REPO],
})
export class MentorsModule {}
