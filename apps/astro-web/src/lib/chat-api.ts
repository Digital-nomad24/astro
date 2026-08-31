import type { ChatHistoryPage, ChatRetentionNotice } from '@astro/contracts';

import { apiGet } from './api';

export function getSessionMessages(
  sessionId: string,
  params?: { before?: string; limit?: number },
): Promise<ChatHistoryPage & { retention: ChatRetentionNotice }> {
  const search = new URLSearchParams();
  if (params?.before) search.set('before', params.before);
  if (params?.limit) search.set('limit', String(params.limit));
  const qs = search.toString();
  return apiGet<ChatHistoryPage & { retention: ChatRetentionNotice }>(
    `/sessions/${sessionId}/messages${qs ? `?${qs}` : ''}`,
  );
}
