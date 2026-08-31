import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@astro/errors';
import type { MentorSort } from '@astro/contracts';

import { decodeCursor, toPage, type Page } from '../../../common/pagination/cursor';
import type {
  IMentorCategoryRepo,
  IMentorProfileRecord,
  IMentorProfileRepo,
} from '../../domain/repos/mentor.repos';
import { MENTOR_CATEGORY_REPO, MENTOR_PROFILE_REPO } from '../../tokens';
import { toMentorCard, type MentorCardResponse } from '../mappers/mentor.mapper';

export interface ListMentorsParams {
  categorySlug?: string;
  onlineOnly?: boolean;
  maxRatePaisePerMinute?: number;
  language?: string;
  search?: string;
  sort?: MentorSort;
  limit?: number;
  cursor?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

@Injectable()
export class ListMentorsUseCase {
  constructor(
    @Inject(MENTOR_PROFILE_REPO) private readonly mentors: IMentorProfileRepo,
    @Inject(MENTOR_CATEGORY_REPO) private readonly categories: IMentorCategoryRepo,
  ) {}

  async execute(params: ListMentorsParams): Promise<Page<MentorCardResponse>> {
    const sort: MentorSort = params.sort ?? 'RATING';
    const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // Resolve the slug to an id up front so the query filters on the indexed column. Filtering
    // through the relation would work, but it takes the browse query off its covering index.
    let categoryId: string | undefined;
    if (params.categorySlug) {
      const category = await this.categories.findBySlug(params.categorySlug);
      if (!category) {
        throw new NotFoundError(
          'CATEGORY_NOT_FOUND',
          `No category with slug "${params.categorySlug}".`,
        );
      }
      categoryId = category.id;
    }

    const rows = await this.mentors.listBookable({
      categoryId,
      onlineOnly: params.onlineOnly,
      maxRatePaisePerMinute: params.maxRatePaisePerMinute,
      language: params.language,
      search: params.search,
      sort,
      limit,
      cursor: params.cursor ? decodeCursor(params.cursor) : null,
    });

    // The cursor must carry the SAME column the query sorted on, or the next page seeks against
    // the wrong axis and silently returns nonsense.
    const page = toPage(rows, limit, (row) => ({ v: sortValueOf(row, sort), id: row.id }));

    return { items: page.items.map(toMentorCard), nextCursor: page.nextCursor };
  }
}

function sortValueOf(row: IMentorProfileRecord, sort: MentorSort): string | number {
  switch (sort) {
    case 'RATING':
      return row.ratingAvg;
    case 'PRICE_ASC':
    case 'PRICE_DESC':
      return row.ratePaisePerMinute;
    case 'NEWEST':
      return row.createdAt.toISOString();
  }
}
