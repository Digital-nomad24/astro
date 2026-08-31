import type { Role } from '@astro/contracts';

import type { MeResponse } from '../types/api';

/** Mentors (and admins acting as mentors) — desk is their product surface. */
export function isMentorRole(role: Role | undefined | null): boolean {
  return role === 'MENTOR' || role === 'ADMIN';
}

/** Seekers — browse / call mentors. Mentors and admins are not seekers. */
export function isSeekerRole(role: Role | undefined | null): boolean {
  return role === 'USER';
}

export function isAdminRole(role: Role | undefined | null): boolean {
  return role === 'ADMIN';
}

/** Post-auth / catch-all home for an onboarded user. */
export function homePathForRole(role: Role | undefined | null): string {
  if (role === 'ADMIN') return '/admin';
  if (role === 'MENTOR') return '/desk';
  return '/browse';
}

export function homePathForMe(me: MeResponse | null | undefined): string {
  if (!me?.onboardedAt) return '/onboard';
  return homePathForRole(me.role);
}
