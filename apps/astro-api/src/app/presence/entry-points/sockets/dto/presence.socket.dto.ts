import { IsArray, IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/**
 * Note what is NOT validated here: the subscription size caps.
 *
 * A pipe rejection throws, and a throw inside a `@SubscribeMessage` handler means Nest emits
 * an `exception` event and the client's ack callback never fires — the caller hangs. Since
 * an over-long list is an ordinary thing a paging client will do, it has to come back as a
 * typed ack (`too_many_ids`), which means enforcing the cap inside the handler instead.
 *
 * Structural violations (wrong types) stay here: those are programming errors, not runtime
 * conditions, and clients should use `socket.timeout(...).emit(...)` to bound them.
 */
export class PresenceSubscribeDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  categorySlugs?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mentorProfileIds?: string[];
}

export class MentorGoOnlineDto {
  @IsOptional()
  @IsBoolean()
  acceptingNewCalls?: boolean;
}

export class MentorSetAcceptingDto {
  @IsBoolean()
  accepting!: boolean;
}
