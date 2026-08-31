import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  RATING_MAX,
  RATING_MIN,
  type MentorRatingSummary,
  type ReviewView,
} from '@astro/contracts';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import type { Page } from '../../../common/pagination/cursor';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import { CurrentUser, Roles } from '../../../identity/contracts/decorators';
import {
  GetMentorRatingUseCase,
  GetSessionReviewUseCase,
  ListMentorReviewsUseCase,
  ModerateReviewUseCase,
  SubmitReviewUseCase,
} from '../../application/use-cases/review.use-cases';

export class SubmitReviewDto {
  @ApiProperty({ minimum: RATING_MIN, maximum: RATING_MAX })
  @Type(() => Number)
  @IsInt()
  @Min(RATING_MIN)
  @Max(RATING_MAX)
  rating!: number;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class ListReviewsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class ModerateReviewDto {
  @ApiProperty()
  @IsBoolean()
  hidden!: boolean;

  @ApiPropertyOptional({ description: 'Required when hiding. Recorded on the review.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

@ApiTags('reviews')
@ApiBearerAuth('firebase')
@Controller()
export class ReviewsController {
  constructor(
    private readonly submitReview: SubmitReviewUseCase,
    private readonly getSessionReview: GetSessionReviewUseCase,
    private readonly listMentorReviews: ListMentorReviewsUseCase,
    private readonly getMentorRating: GetMentorRatingUseCase,
  ) {}

  /**
   * Create or replace the caller's review of a consultation.
   *
   * A PUT in spirit — one review per session, and re-submitting adjusts it. Kept as POST
   * because the client does not know whether one exists, and making it guess would produce a
   * round trip whose only purpose is choosing a verb.
   */
  @Post('sessions/:id/review')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rate a completed consultation. Re-submitting edits your review.' })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
    @Body() dto: SubmitReviewDto,
  ): Promise<ReviewView> {
    return this.submitReview.execute(user, sessionId, dto);
  }

  @Get('sessions/:id/review')
  @ApiOperation({ summary: "This consultation's review, visible to both participants." })
  forSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
  ): Promise<ReviewView | null> {
    return this.getSessionReview.execute(user, sessionId);
  }

  @Get('mentors/:id/reviews')
  @ApiOperation({ summary: "A mentor's reviews, newest first. Keyset paginated." })
  forMentor(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') mentorProfileId: string,
    @Query() query: ListReviewsQueryDto,
  ): Promise<Page<ReviewView>> {
    return this.listMentorReviews.execute(user, mentorProfileId, query);
  }

  @Get('mentors/:id/rating')
  @ApiOperation({ summary: 'Average, count and star distribution.' })
  rating(@Param('id') mentorProfileId: string): Promise<MentorRatingSummary> {
    return this.getMentorRating.execute(mentorProfileId);
  }
}

@ApiTags('admin')
@ApiBearerAuth('firebase')
@Controller('admin/reviews')
@Roles('ADMIN')
export class AdminReviewsController {
  constructor(private readonly moderate: ModerateReviewUseCase) {}

  /**
   * Hiding a review removes it from the mentor's aggregate in the same transaction — otherwise
   * the browse card would keep counting an opinion nobody can read.
   */
  @Post(':id/moderate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hide or unhide a review, adjusting the mentor rating.' })
  setHidden(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') reviewId: string,
    @Body() dto: ModerateReviewDto,
  ): Promise<{ changed: boolean }> {
    return this.moderate.execute(admin, reviewId, dto.hidden, dto.reason ?? null);
  }
}
