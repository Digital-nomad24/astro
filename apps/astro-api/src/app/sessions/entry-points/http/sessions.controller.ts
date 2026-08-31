import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { SessionView } from '@astro/contracts';

import type { Page } from '../../../common/pagination/cursor';
import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import { CurrentUser, RequireOnboarded } from '../../../identity/contracts/decorators';
import {
  AcceptSessionUseCase,
  CancelSessionUseCase,
  DeclineSessionUseCase,
  EndSessionUseCase,
  GetActiveSessionUseCase,
  GetSessionUseCase,
  IssueSessionCredentialsUseCase,
  ListSessionsUseCase,
  RecordConsentUseCase,
  StartSessionUseCase,
  type StartSessionResult,
} from '../../application/use-cases/session.use-cases';
import { ListSessionsQueryDto, StartSessionDto } from './dto/session.dto';

/**
 * Every session mutation lives here, not on the `/calls` socket.
 *
 * The gateway is a push channel; these are the writes. Keeping them on HTTP means one code
 * path per transition — with the global `ValidationPipe`, `AllExceptionsFilter` and ordinary
 * status codes — instead of two surfaces that can drift apart on which of them enforces what.
 */
@ApiTags('sessions')
@ApiBearerAuth('firebase')
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly startSession: StartSessionUseCase,
    private readonly acceptSession: AcceptSessionUseCase,
    private readonly declineSession: DeclineSessionUseCase,
    private readonly cancelSession: CancelSessionUseCase,
    private readonly endSession: EndSessionUseCase,
    private readonly recordConsent: RecordConsentUseCase,
    private readonly issueCredentials: IssueSessionCredentialsUseCase,
    private readonly getSession: GetSessionUseCase,
    private readonly getActive: GetActiveSessionUseCase,
    private readonly listSessions: ListSessionsUseCase,
  ) {}

  /**
   * `@RequireOnboarded()`: a mentor answering a call needs someone to answer *to*. An account
   * with no display name would ring through as an anonymous stranger.
   */
  @Post()
  @RequireOnboarded()
  @ApiOperation({
    summary: 'Start a session with a mentor. Returns join credentials for VOICE.',
  })
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StartSessionDto,
  ): Promise<StartSessionResult> {
    return this.startSession.execute(user, dto);
  }

  /** Declared before `:id` — Nest matches in declaration order. */
  @Get('active')
  @ApiOperation({ summary: "The caller's in-flight session, from either side. Null if none." })
  active(@CurrentUser() user: AuthenticatedUser): Promise<SessionView | null> {
    return this.getActive.execute(user);
  }

  @Get()
  @ApiOperation({ summary: 'Session history. Keyset paginated, newest first.' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListSessionsQueryDto,
  ): Promise<Page<SessionView>> {
    return this.listSessions.execute(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One session. 404 for anyone who is not a participant.' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<SessionView> {
    return this.getSession.execute(user, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mentor accepts a ringing session. 409 if it already timed out.' })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<StartSessionResult> {
    return this.acceptSession.execute(user, id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mentor declines a ringing session.' })
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<SessionView> {
    return this.declineSession.execute(user, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Caller cancels before the mentor answers.' })
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<SessionView> {
    return this.cancelSession.execute(user, id);
  }

  @Post(':id/end')
  @HttpCode(200)
  @ApiOperation({ summary: 'Either party hangs up.' })
  end(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<SessionView> {
    return this.endSession.execute(user, id);
  }

  /**
   * Records THIS caller's consent to recording. Consent is per party and per session, and it
   * gates `StartEgress` itself in M8 — never merely the summary that follows. A recording
   * taken without consent cannot be un-taken, which is why the columns and this route ship
   * with the session lifecycle rather than with the summariser.
   */
  @Post(':id/consent')
  @HttpCode(200)
  @ApiOperation({ summary: 'Consent to this session being recorded for a summary.' })
  consent(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<SessionView> {
    return this.recordConsent.execute(user, id);
  }

  /**
   * The rejoin path: a refreshed tab or a changed network asks for a fresh token. Nothing about
   * the session changes, which is why this never fails a session that is merely reconnecting.
   */
  @Post(':id/credentials')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-issue LiveKit join credentials for a session in progress.' })
  credentials(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<StartSessionResult> {
    return this.issueCredentials.execute(user, id);
  }
}
