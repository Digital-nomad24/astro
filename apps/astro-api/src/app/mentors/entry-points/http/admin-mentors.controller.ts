import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Page } from '../../../common/pagination/cursor';
import { CurrentUser, Roles } from '../../../identity/contracts/decorators';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type {
  MentorCategoryResponse,
  MyMentorProfileResponse,
} from '../../application/mappers/mentor.mapper';
import {
  CreateMentorCategoryUseCase,
  ListMentorApplicationsUseCase,
  ReviewMentorApplicationUseCase,
  UpdateMentorCategoryUseCase,
} from '../../application/use-cases/admin-mentors.use-cases';
import {
  CreateMentorCategoryDto,
  ListMentorApplicationsQueryDto,
  ReviewMentorApplicationDto,
  UpdateMentorCategoryDto,
} from './dto/mentor.dto';

/**
 * `@Roles('ADMIN')` at the class level, so every route added here inherits it. A future
 * handler cannot accidentally ship unrestricted — it would have to explicitly override.
 */
@ApiTags('admin')
@ApiBearerAuth('firebase')
@Roles('ADMIN')
@Controller('admin')
export class AdminMentorsController {
  constructor(
    private readonly listApplications: ListMentorApplicationsUseCase,
    private readonly reviewApplication: ReviewMentorApplicationUseCase,
    private readonly createCategory: CreateMentorCategoryUseCase,
    private readonly updateCategory: UpdateMentorCategoryUseCase,
  ) {}

  @Get('mentors')
  @ApiOperation({ summary: 'Moderation queue, oldest first. Defaults to PENDING.' })
  applications(
    @Query() query: ListMentorApplicationsQueryDto,
  ): Promise<Page<MyMentorProfileResponse>> {
    return this.listApplications.execute(query);
  }

  @Post('mentors/:id/review')
  @ApiOperation({ summary: 'Approve, reject or suspend a mentor.' })
  review(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReviewMentorApplicationDto,
  ): Promise<MyMentorProfileResponse> {
    return this.reviewApplication.execute(admin, id, dto.status, dto.note ?? null);
  }

  @Post('mentor-categories')
  @ApiOperation({ summary: 'Create a consultation category.' })
  create(@Body() dto: CreateMentorCategoryDto): Promise<MentorCategoryResponse> {
    return this.createCategory.execute(dto);
  }

  @Patch('mentor-categories/:id')
  @ApiOperation({ summary: 'Update a category. The slug is immutable by design.' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMentorCategoryDto,
  ): Promise<MentorCategoryResponse> {
    return this.updateCategory.execute(id, dto);
  }
}
