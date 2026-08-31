import { IsOptional, IsString, IsUrl, Length, ValidateIf } from 'class-validator';

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(2, 60, { message: 'displayName must be between 2 and 60 characters' })
  displayName?: string;

  /**
   * `null` clears the photo; omitting the key leaves it untouched. `@ValidateIf` is what keeps
   * those two distinguishable — without it, `@IsUrl` would reject an explicit null.
   */
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUrl({ require_protocol: true }, { message: 'photoUrl must be an absolute URL' })
  photoUrl?: string | null;
}
