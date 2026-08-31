import { Injectable } from '@nestjs/common';

import type { User as UserRow } from 'prisma/src/generated/prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import type {
  IAuthUserRecord,
  IAuthUserRepo,
  IProvisionAuthUserParams,
  IUpdateProfileParams,
} from '../../../../domain/repos/auth-user.repo.interface';

@Injectable()
export class AuthUserPrismaRepo implements IAuthUserRepo {
  constructor(private readonly prisma: PrismaService) {}

  async findByFirebaseUid(firebaseUid: string): Promise<IAuthUserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { firebaseUid } });
    return row ? this.map(row) : null;
  }

  /**
   * `createMany({ skipDuplicates: true })` is ON CONFLICT DO NOTHING against the
   * `firebaseUid` unique index, so two concurrent first requests from the same new user
   * produce exactly one row and neither request errors. A bare `create` would have one of
   * them throw P2002, and `upsert` would still race on the read-then-write.
   *
   * The follow-up read is unconditional rather than branching on `count`, because the winner
   * and the loser both need the same row back.
   */
  async provision(params: IProvisionAuthUserParams): Promise<IAuthUserRecord> {
    await this.prisma.user.createMany({
      data: [
        {
          firebaseUid: params.firebaseUid,
          authProvider: params.authProvider,
          email: params.email,
          phoneNumber: params.phoneNumber,
          displayName: params.displayName,
          photoUrl: params.photoUrl,
        },
      ],
      skipDuplicates: true,
    });

    const row = await this.prisma.user.findUniqueOrThrow({
      where: { firebaseUid: params.firebaseUid },
    });
    return this.map(row);
  }

  async syncEmail(firebaseUid: string, email: string | null): Promise<IAuthUserRecord> {
    const row = await this.prisma.user.update({
      where: { firebaseUid },
      data: { email },
    });
    return this.map(row);
  }

  async updateProfile(userId: string, params: IUpdateProfileParams): Promise<IAuthUserRecord> {
    const row = await this.prisma.user.update({
      where: { id: userId },
      // Only keys actually present are written, so `undefined` never clears a column —
      // "not supplied" and "set to null" are different requests.
      data: {
        ...(params.displayName !== undefined ? { displayName: params.displayName } : {}),
        ...(params.photoUrl !== undefined ? { photoUrl: params.photoUrl } : {}),
      },
    });
    return this.map(row);
  }

  /**
   * Stamp-only-if-null: the `onboardedAt: null` predicate means a second call updates zero
   * rows instead of moving the timestamp forward. The read afterwards returns the row either
   * way, so callers do not have to care whether they were the one who stamped it.
   */
  async markOnboarded(userId: string): Promise<IAuthUserRecord> {
    await this.prisma.user.updateMany({
      where: { id: userId, onboardedAt: null },
      data: { onboardedAt: new Date() },
    });

    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.map(row);
  }

  /**
   * The one place a Prisma row becomes a domain record. Typed from the generated `User` so
   * adding a column is a compile error here rather than a silently missing field downstream.
   */
  private map(row: UserRow): IAuthUserRecord {
    return {
      id: row.id,
      firebaseUid: row.firebaseUid,
      role: row.role,
      authProvider: row.authProvider,
      email: row.email,
      phoneNumber: row.phoneNumber,
      displayName: row.displayName,
      photoUrl: row.photoUrl,
      onboardedAt: row.onboardedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
