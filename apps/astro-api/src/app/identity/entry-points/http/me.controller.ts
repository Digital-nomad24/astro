import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { GetMeUseCase } from '../../application/use-cases/get-me.use-case';
import { UpdateMeUseCase } from '../../application/use-cases/update-me.use-case';
import type { MeResponse } from '../../application/mappers/me.mapper';
import { CurrentUser } from '../../contracts/decorators';
import type { AuthenticatedUser } from '../../contracts/authenticated-user';
import { UpdateMeDto } from './dto/update-me.dto';

/**
 * There is deliberately no `POST /auth/sync`. The guard provisions the shadow row on the
 * first authenticated request, whichever endpoint that happens to be, so a client can sign in
 * with email/password or Google and immediately call anything.
 */
@ApiTags('identity')
@ApiBearerAuth('firebase')
@Controller('me')
export class MeController {
  constructor(
    private readonly getMe: GetMeUseCase,
    private readonly updateMe: UpdateMeUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The authenticated user. Provisions the account on first call.' })
  get(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    return this.getMe.execute(user.firebaseUid);
  }

  @Patch()
  @ApiOperation({ summary: 'Update the profile. Setting a display name completes onboarding.' })
  update(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateMeDto): Promise<MeResponse> {
    return this.updateMe.execute(user, dto);
  }
}
