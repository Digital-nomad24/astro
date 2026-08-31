import type { AuthProvider, MentorApprovalStatus, PresenceState, Role } from '@astro/contracts';

export interface MeResponse {
  id: string;
  role: Role;
  authProvider: AuthProvider;
  email: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  photoUrl: string | null;
  onboardedAt: string | null;
  createdAt: string;
}

export interface MentorCardResponse {
  id: string;
  displayName: string;
  headline: string | null;
  categorySlug: string;
  categoryName: string;
  languages: readonly string[];
  experienceYears: number;
  ratePaisePerMinute: number;
  presenceState: PresenceState;
  acceptingNewCalls: boolean;
  queueDepth: number;
  ratingAvg: number;
  ratingCount: number;
  totalSessions: number;
}

export interface MentorDetailResponse extends MentorCardResponse {
  bio: string | null;
  memberSince: string;
}

export interface MyMentorProfileResponse extends MentorDetailResponse {
  approvalStatus: MentorApprovalStatus;
  approvalNote: string | null;
  approvedAt: string | null;
  isBookable: boolean;
}

export interface MentorCategoryResponse {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
