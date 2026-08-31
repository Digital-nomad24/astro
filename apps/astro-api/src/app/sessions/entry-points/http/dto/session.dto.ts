import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SUPPORTED_SESSION_MODES, type SupportedSessionMode } from '@astro/contracts';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class StartSessionDto {
  @ApiProperty({ description: 'The mentor to consult.' })
  @IsString()
  mentorProfileId!: string;

  /**
   * `VIDEO` is absent from this list on purpose. It exists in the enum so enabling it later is
   * a grant change rather than a migration, but a request for it must not reach the use case —
   * the DTO rejects it with a 400 before any session row exists.
   */
  @ApiProperty({ enum: SUPPORTED_SESSION_MODES })
  @IsIn(SUPPORTED_SESSION_MODES as readonly string[])
  mode!: SupportedSessionMode;
}

export class ListSessionsQueryDto {
  @ApiPropertyOptional({
    enum: ['user', 'mentor'],
    description: 'Which side of the consultation to list. Defaults to the caller as the user.',
  })
  @IsOptional()
  @IsIn(['user', 'mentor'])
  as?: 'user' | 'mentor';

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page.' })
  @IsOptional()
  @IsString()
  cursor?: string;
}
