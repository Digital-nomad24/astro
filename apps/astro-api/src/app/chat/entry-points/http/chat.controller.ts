import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { ChatHistoryPage, ChatRetentionNotice } from '@astro/contracts';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import { CurrentUser } from '../../../identity/contracts/decorators';
import { ChatService } from '../../application/services/chat.service';

export class ChatHistoryQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  before?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * Transcript reading over HTTP.
 *
 * The `/chat` socket already returns history in its join ack, which is the right shape for a
 * live conversation. This exists for the other case: reading a *past* consultation from the
 * session history list or the mentor dashboard, where opening a socket to read a finished
 * conversation would be absurd.
 *
 * There is no HTTP send. Writes stay on the socket, where the fan-out to the other participant
 * has to happen anyway.
 */
@ApiTags('chat')
@ApiBearerAuth('firebase')
@Controller('sessions/:id')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('messages')
  @ApiOperation({
    summary:
      'Transcript for a text session, newest first. Returns purgedAt once the transcript ' +
      'has been deleted under the retention policy.',
  })
  async messages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
    @Query() query: ChatHistoryQueryDto,
  ): Promise<ChatHistoryPage & { retention: ChatRetentionNotice }> {
    const session = await this.chat.requireTextSession(user, sessionId);
    const history = await this.chat.history(user, sessionId, query.before, query.limit);

    // The retention notice rides along so a history view can say when the transcript goes
    // away, rather than a user discovering it did.
    return { ...history, retention: this.chat.retentionNoticeFor(session) };
  }
}
