import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Page } from '../../../common/pagination/cursor';
import { CurrentUser, RequireOnboarded, Roles } from '../../../identity/contracts/decorators';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type {
  MentorCardResponse,
  MentorCategoryResponse,
  MentorDetailResponse,
  MyMentorProfileResponse,
} from '../../application/mappers/mentor.mapper';
import { ListMentorCategoriesUseCase } from '../../application/use-cases/admin-mentors.use-cases';
import { ApplyAsMentorUseCase } from '../../application/use-cases/apply-as-mentor.use-case';
import { GetMentorUseCase } from '../../application/use-cases/get-mentor.use-case';
import { ListMentorsUseCase } from '../../application/use-cases/list-mentors.use-case';
import {
  GetMyMentorProfileUseCase,
  UpdateMyMentorProfileUseCase,
} from '../../application/use-cases/my-mentor-profile.use-cases';
import { ApplyAsMentorDto, ListMentorsQueryDto, UpdateMyMentorProfileDto } from './dto/mentor.dto';

/**
 * Browsing requires a signed-in user. The catalogue — who is available, at what price — is
 * the product's core inventory, and leaving it unauthenticated makes it trivially scrapeable
 * by competitors and bots. Nothing here is `@Public()`.
 */
@ApiTags('mentors')
@ApiBearerAuth('firebase')
@Controller()
export class MentorsController {
  constructor(
    private readonly listMentors: ListMentorsUseCase,
    private readonly getMentor: GetMentorUseCase,
    private readonly listCategories: ListMentorCategoriesUseCase,
    private readonly applyAsMentor: ApplyAsMentorUseCase,
    private readonly getMyProfile: GetMyMentorProfileUseCase,
    private readonly updateMyProfile: UpdateMyMentorProfileUseCase,
  ) {}

  @Get('mentor-categories')
  @ApiOperation({ summary: 'Active consultation categories.' })
  categories(): Promise<MentorCategoryResponse[]> {
    return this.listCategories.execute();
  }

  @Get('mentors')
  @ApiOperation({ summary: 'Browse bookable mentors. Keyset paginated via an opaque cursor.' })
  list(@Query() query: ListMentorsQueryDto): Promise<Page<MentorCardResponse>> {
    return this.listMentors.execute(query);
  }

  /**
   * Declared before `mentors/:id` — Nest matches in declaration order, so a literal path that
   * could be read as an id must come first or `/mentors/me` resolves as a mentor named "me".
   */
  @Get('mentors/me')
  @Roles('MENTOR', 'ADMIN')
  @ApiOperation({ summary: "The signed-in mentor's own profile, including approval status." })
  myProfile(@CurrentUser() user: AuthenticatedUser): Promise<MyMentorProfileResponse> {
    return this.getMyProfile.execute(user);
  }

  @Patch('mentors/me')
  @Roles('MENTOR', 'ADMIN')
  @ApiOperation({ summary: 'Update your mentor profile.' })
  updateMine(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMyMentorProfileDto,
  ): Promise<MyMentorProfileResponse> {
    return this.updateMyProfile.execute(user, dto);
  }

  @Get('mentors/:id')
  @ApiOperation({ summary: 'A bookable mentor. 404 for anyone not approved.' })
  detail(@Param('id') id: string): Promise<MentorDetailResponse> {
    return this.getMentor.execute(id);
  }

  /**
   * `@RequireOnboarded()`: an applicant must have completed their own profile first. It is
   * also the only sensible gate — a mentor with no display name cannot be reviewed.
   */
  @Post('mentors/apply')
  @RequireOnboarded()
  @ApiOperation({ summary: 'Apply to become a mentor. Creates a PENDING profile.' })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApplyAsMentorDto,
  ): Promise<MyMentorProfileResponse> {
    return this.applyAsMentor.execute(user, dto);
  }
}
