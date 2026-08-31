import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  MENTOR_APPROVAL_STATUSES,
  MENTOR_SORT_OPTIONS,
  type MentorApprovalStatus,
  type MentorSort,
} from '@astro/contracts';

/** A day of consultation at a sane rate — an upper bound that catches a paise/rupee mix-up. */
const MAX_RATE_PAISE_PER_MINUTE = 1_000_00;

export class ListMentorsQueryDto {
  @IsOptional()
  @IsString()
  categorySlug?: string;

  /** Query strings are text; `@Type` is what turns "true" into a boolean before validation. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  onlineOnly?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxRatePaisePerMinute?: number;

  @IsOptional()
  @IsString()
  @Length(2, 40)
  language?: string;

  @IsOptional()
  @IsString()
  @Length(2, 60)
  search?: string;

  @IsOptional()
  @IsIn(MENTOR_SORT_OPTIONS)
  sort?: MentorSort;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export class ApplyAsMentorDto {
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'categorySlug must be kebab-case' })
  categorySlug!: string;

  @IsString()
  @Length(2, 60)
  displayName!: string;

  @IsOptional()
  @IsString()
  @Length(0, 140)
  headline?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  bio?: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'List at least one language you consult in' })
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  languages!: string[];

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(80)
  experienceYears!: number;

  /**
   * `@Min(1)`, never 0. A zero rate makes `balance / rate` infinite — a session that can never
   * be cut off for running out of money. A CHECK constraint enforces the same thing in
   * Postgres, because this one matters too much to live only in a DTO.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RATE_PAISE_PER_MINUTE)
  ratePaisePerMinute!: number;
}

export class UpdateMyMentorProfileDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'categorySlug must be kebab-case' })
  categorySlug?: string;

  @IsOptional()
  @IsString()
  @Length(2, 60)
  displayName?: string;

  /** `null` clears; omission leaves untouched. `@ValidateIf` keeps those distinguishable. */
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @Length(0, 140)
  headline?: string | null;

  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @Length(0, 2000)
  bio?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  languages?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(80)
  experienceYears?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RATE_PAISE_PER_MINUTE)
  ratePaisePerMinute?: number;
}

export class ReviewMentorApplicationDto {
  @IsIn(MENTOR_APPROVAL_STATUSES.filter((status) => status !== 'PENDING'))
  status!: MentorApprovalStatus;

  /** Shown to the mentor on rejection, so it is required when refusing them. */
  @ValidateIf((dto: ReviewMentorApplicationDto) => dto.status !== 'APPROVED')
  @IsString()
  @Length(3, 500, { message: 'Give a reason when rejecting or suspending a mentor' })
  note?: string;
}

export class ListMentorApplicationsQueryDto {
  @IsOptional()
  @IsIn(MENTOR_APPROVAL_STATUSES)
  status?: MentorApprovalStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

export class CreateMentorCategoryDto {
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug must be kebab-case' })
  @Length(2, 40)
  slug!: string;

  @IsString()
  @Length(2, 60)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  description?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  iconUrl?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateMentorCategoryDto {
  @IsOptional()
  @IsString()
  @Length(2, 60)
  name?: string;

  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @Length(0, 300)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsUrl({ require_protocol: true })
  iconUrl?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;
}
