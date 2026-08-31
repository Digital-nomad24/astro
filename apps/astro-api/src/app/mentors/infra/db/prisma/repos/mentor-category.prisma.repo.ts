import { Injectable } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';
import type {
  IMentorCategoryRecord,
  IMentorCategoryRepo,
} from '../../../../domain/repos/mentor.repos';

type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  sortOrder: number;
  isActive: boolean;
};

@Injectable()
export class MentorCategoryPrismaRepo implements IMentorCategoryRepo {
  constructor(private readonly prisma: PrismaService) {}

  async listActive(): Promise<IMentorCategoryRecord[]> {
    const rows = await this.prisma.mentorCategory.findMany({
      where: { isActive: true },
      // Editorial order first, name as the tiebreaker so the list is stable across requests.
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toRecord);
  }

  async findBySlug(slug: string): Promise<IMentorCategoryRecord | null> {
    const row = await this.prisma.mentorCategory.findUnique({ where: { slug } });
    return row ? toRecord(row) : null;
  }

  async findById(id: string): Promise<IMentorCategoryRecord | null> {
    const row = await this.prisma.mentorCategory.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async create(params: Omit<IMentorCategoryRecord, 'id'>): Promise<IMentorCategoryRecord> {
    const row = await this.prisma.mentorCategory.create({ data: params });
    return toRecord(row);
  }

  async update(
    id: string,
    params: Partial<Omit<IMentorCategoryRecord, 'id' | 'slug'>>,
  ): Promise<IMentorCategoryRecord> {
    const row = await this.prisma.mentorCategory.update({
      where: { id },
      data: {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.description !== undefined ? { description: params.description } : {}),
        ...(params.iconUrl !== undefined ? { iconUrl: params.iconUrl } : {}),
        ...(params.sortOrder !== undefined ? { sortOrder: params.sortOrder } : {}),
        ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
      },
    });
    return toRecord(row);
  }
}

const toRecord = (row: CategoryRow): IMentorCategoryRecord => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  iconUrl: row.iconUrl,
  sortOrder: row.sortOrder,
  isActive: row.isActive,
});
