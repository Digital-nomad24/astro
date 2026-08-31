import { ConfigService } from '@nestjs/config';
import { ConflictError, TooManyRequestsError, ValidationError } from '@astro/errors';

import type { AuthenticatedUser } from '../../../identity/contracts/authenticated-user';
import type { ISessionRecord } from '../../../sessions/domain/repos/session.repos';
import type { SessionLifecycleService } from '../../../sessions/application/services/session-lifecycle.service';
import type { ChatRateLimitService } from '../../infra/redis/chat-rate-limit.service';
import type { IChatMessageRecord, IChatMessageRepo } from '../../domain/repos/chat.repos';
import { ChatService } from './chat.service';

const USER: AuthenticatedUser = {
  id: 'usr_1',
  firebaseUid: 'fb_1',
  role: 'USER',
  authProvider: 'GOOGLE',
  email: 'u@example.invalid',
  displayName: 'Caller',
  onboardedAt: new Date(),
};

const SESSION: ISessionRecord = {
  id: 'ses_1',
  mode: 'TEXT',
  status: 'ACTIVE',
  userId: 'usr_1',
  userDisplayName: 'Ravi',
  mentorProfileId: 'mnt_1',
  mentorUserId: 'usr_2',
  mentorDisplayName: 'Asha',
  ratePaisePerMinute: 2000,
  platformFeeBps: 3000,
  createdAt: new Date('2026-08-01T10:00:00Z'),
  ringingAt: new Date('2026-08-01T10:00:00Z'),
  acceptedAt: new Date('2026-08-01T10:00:05Z'),
  billingAnchorAt: null,
  endedAt: null,
  endReason: null,
  livekitRoomName: null,
  livekitRoomSid: null,
  participantJoinCount: 0,
  connectedIdentities: [],
  recordingConsentUserAt: null,
  recordingConsentMentorAt: null,
  egressId: null,
  summaryIneligibleReason: null,
  lastMessageAt: null,
  messageCount: 0,
  messagesPurgedAt: null,
  rating: null,
};

const MESSAGE: IChatMessageRecord = {
  id: 'msg_1',
  sessionId: 'ses_1',
  senderUserId: 'usr_1',
  body: 'hello',
  clientMsgId: 'c1',
  createdAt: new Date('2026-08-01T10:00:10Z'),
};

const config = {
  get: (key: string) =>
    ({
      CHAT_HISTORY_PAGE_SIZE: 50,
      CHAT_MESSAGE_MAX_LENGTH: 4000,
      CHAT_RETENTION_DAYS: 7,
    })[key],
} as unknown as ConfigService<never, true>;

describe('ChatService', () => {
  let messages: jest.Mocked<IChatMessageRepo>;
  let sessions: jest.Mocked<
    Pick<SessionLifecycleService, 'requireParticipant' | 'announceTextAnchor'>
  >;
  let rateLimit: jest.Mocked<Pick<ChatRateLimitService, 'allow'>>;
  let service: ChatService;

  beforeEach(() => {
    messages = {
      append: jest.fn().mockResolvedValue({ message: MESSAGE, duplicate: false, anchored: false }),
      history: jest.fn().mockResolvedValue([]),
      findIdleTextSessions: jest.fn().mockResolvedValue([]),
      findPurgeableTranscripts: jest.fn().mockResolvedValue([]),
      purgeTranscript: jest.fn().mockResolvedValue(0),
    };
    sessions = {
      requireParticipant: jest.fn().mockResolvedValue(SESSION),
      announceTextAnchor: jest.fn().mockResolvedValue(undefined),
    };
    rateLimit = { allow: jest.fn().mockResolvedValue(true) };

    service = new ChatService(
      messages,
      sessions as unknown as SessionLifecycleService,
      rateLimit as unknown as ChatRateLimitService,
      config,
    );
  });

  describe('send', () => {
    it('stores the message and reports it as new', async () => {
      const result = await service.send(USER, {
        sessionId: 'ses_1',
        body: 'hello',
        clientMsgId: 'c1',
      });

      expect(result.duplicate).toBe(false);
      expect(result.message.body).toBe('hello');
      expect(messages.append).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'ses_1', senderUserId: 'usr_1', clientMsgId: 'c1' }),
      );
    });

    it('trims the body before storing it', async () => {
      await service.send(USER, { sessionId: 'ses_1', body: '  hi  ', clientMsgId: 'c1' });
      expect(messages.append).toHaveBeenCalledWith(expect.objectContaining({ body: 'hi' }));
    });

    it('rejects a message that is only whitespace', async () => {
      // An empty message is a client bug, and it would reach the M8 summariser as noise.
      await expect(
        service.send(USER, { sessionId: 'ses_1', body: '   ', clientMsgId: 'c1' }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(messages.append).not.toHaveBeenCalled();
    });

    it('rejects a message over the configured limit', async () => {
      await expect(
        service.send(USER, { sessionId: 'ses_1', body: 'x'.repeat(4001), clientMsgId: 'c1' }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses to send into a session that is not ACTIVE', async () => {
      sessions.requireParticipant.mockResolvedValue({ ...SESSION, status: 'COMPLETED' });
      await expect(
        service.send(USER, { sessionId: 'ses_1', body: 'hi', clientMsgId: 'c1' }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('refuses to treat a voice session as a chat', async () => {
      sessions.requireParticipant.mockResolvedValue({ ...SESSION, mode: 'VOICE' });
      await expect(
        service.send(USER, { sessionId: 'ses_1', body: 'hi', clientMsgId: 'c1' }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('rate limits before writing anything', async () => {
      rateLimit.allow.mockResolvedValue(false);
      await expect(
        service.send(USER, { sessionId: 'ses_1', body: 'hi', clientMsgId: 'c1' }),
      ).rejects.toBeInstanceOf(TooManyRequestsError);
      expect(messages.append).not.toHaveBeenCalled();
    });

    it('announces the anchor only when THIS message stamped it', async () => {
      // Text metering starts at the first message, not at accept. The repo reports which call
      // did the stamping; announcing on every message would restart the UI's clock constantly.
      messages.append.mockResolvedValue({ message: MESSAGE, duplicate: false, anchored: true });
      await service.send(USER, { sessionId: 'ses_1', body: 'hi', clientMsgId: 'c1' });
      expect(sessions.announceTextAnchor).toHaveBeenCalledWith('ses_1');

      sessions.announceTextAnchor.mockClear();
      messages.append.mockResolvedValue({ message: MESSAGE, duplicate: false, anchored: false });
      await service.send(USER, { sessionId: 'ses_1', body: 'hi again', clientMsgId: 'c2' });
      expect(sessions.announceTextAnchor).not.toHaveBeenCalled();
    });

    it('reports a retried clientMsgId as a duplicate, returning the stored message', async () => {
      messages.append.mockResolvedValue({ message: MESSAGE, duplicate: true, anchored: false });
      const result = await service.send(USER, {
        sessionId: 'ses_1',
        body: 'hello',
        clientMsgId: 'c1',
      });
      // The caller uses this to skip the broadcast — the other party must not see it twice.
      expect(result.duplicate).toBe(true);
      expect(result.message.id).toBe('msg_1');
    });
  });

  describe('history', () => {
    it('returns a cursor only when another page exists', async () => {
      const rows = Array.from({ length: 51 }, (_, i) => ({
        ...MESSAGE,
        id: `msg_${i}`,
        createdAt: new Date(Date.now() - i * 1000),
      }));
      messages.history.mockResolvedValue(rows);

      const page = await service.history(USER, 'ses_1', undefined, 50);

      expect(page.messages).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
    });

    it('has no cursor on the last page', async () => {
      messages.history.mockResolvedValue([MESSAGE]);
      const page = await service.history(USER, 'ses_1', undefined, 50);
      expect(page.nextCursor).toBeNull();
    });

    it('reports a purged transcript distinctly from an empty one', async () => {
      // Both are an empty message array. A client that cannot tell them apart shows a blank
      // pane for a consultation that definitely happened.
      sessions.requireParticipant.mockResolvedValue({
        ...SESSION,
        status: 'COMPLETED',
        messagesPurgedAt: new Date('2026-08-09T00:00:00Z'),
        messageCount: 14,
      });

      const page = await service.history(USER, 'ses_1', undefined, 50);

      expect(page.messages).toEqual([]);
      expect(page.purgedAt).toBe('2026-08-09T00:00:00.000Z');
      expect(page.messageCount).toBe(14);
      // Short-circuited: there is nothing to query.
      expect(messages.history).not.toHaveBeenCalled();
    });

    it('reports an empty live conversation as not purged', async () => {
      const page = await service.history(USER, 'ses_1', undefined, 50);
      expect(page.messages).toEqual([]);
      expect(page.purgedAt).toBeNull();
    });
  });

  describe('retention notice', () => {
    it('computes the deletion date from the END of the session', () => {
      const notice = service.retentionNoticeFor({
        ...SESSION,
        status: 'COMPLETED',
        endedAt: new Date('2026-08-10T12:00:00Z'),
      });

      expect(notice.retentionDays).toBe(7);
      expect(notice.deleteAfter).toBe('2026-08-17T12:00:00.000Z');
    });

    it('has no deletion date while the session is still live', () => {
      // Retention is measured from the end, and a conversation in progress has no end yet.
      expect(service.retentionNoticeFor(SESSION).deleteAfter).toBeNull();
    });
  });
});
