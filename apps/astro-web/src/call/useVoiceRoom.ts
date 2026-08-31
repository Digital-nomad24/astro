import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CallJoinCredentials } from '@astro/contracts';

function attachRemoteAudio(room: Room): void {
  for (const participant of room.remoteParticipants.values()) {
    for (const pub of participant.audioTrackPublications.values()) {
      pub.track?.attach();
    }
  }
}

export function useVoiceRoom(
  credentials: CallJoinCredentials | null,
  enabled: boolean,
): {
  connected: boolean;
  error: string | null;
  setTransmitting: (on: boolean) => void;
  remoteMicMuted: boolean | null;
} {
  const roomRef = useRef<Room | null>(null);
  const desiredRef = useRef(true);
  const applyingRef = useRef(false);
  const pendingRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteMicMuted, setRemoteMicMuted] = useState<boolean | null>(null);

  const reconcileMic = useCallback(async () => {
    if (applyingRef.current) {
      pendingRef.current = true;
      return;
    }
    applyingRef.current = true;
    try {
      do {
        pendingRef.current = false;
        const pub = roomRef.current?.localParticipant.getTrackPublication(
          Track.Source.Microphone,
        );
        // Not published yet — the connect path reconciles once after publishing, so an
        // intent expressed before the room is up is not lost, just deferred.
        if (!pub) break;

        const want = desiredRef.current;
        if (pub.isMuted !== !want) {
          await (want ? pub.unmute() : pub.mute());
        }
      } while (pendingRef.current);
    } finally {
      applyingRef.current = false;
    }
  }, []);

  const setTransmitting = useCallback(
    (on: boolean) => {
      desiredRef.current = on;
      void reconcileMic();
    },
    [reconcileMic],
  );

  useEffect(() => {
    if (!enabled || !credentials) {
      setConnected(false);
      setRemoteMicMuted(null);
      return;
    }

    let cancelled = false;
    const room = new Room();
    roomRef.current = room;

    const recomputeRemote = () => {
      const remote = roomRef.current?.remoteParticipants.values().next().value;
      const pub = remote?.getTrackPublication(Track.Source.Microphone);
      setRemoteMicMuted(pub ? pub.isMuted : null);
    };

    const onTrackSubscribed = (
      track: RemoteTrack,
      _pub: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ) => {
      if (track.kind === Track.Kind.Audio) {
        track.attach();
        void room.startAudio();
      }
      recomputeRemote();
    };

    void (async () => {
      try {
        await room.connect(credentials.url, credentials.token);
        if (cancelled) return;
        const pub = await room.localParticipant.setMicrophoneEnabled(true);
        if (cancelled) return;
        // Published, then muted before `connected` is announced. Publishing up front is what
        // makes the first hold instant; muting here rather than via `reconcileMic` closes the
        // few-ms window in which a live track exists on a room the peer may already be subscribed
        // to. usePushToTalk's effect runs in the same commit, so desiredRef already reflects
        // the stored preference by the time this line runs.
        if (pub && !desiredRef.current) await pub.mute();
        attachRemoteAudio(room);
        void room.startAudio();
        setConnected(true);
        setError(null);
        recomputeRemote();
      } catch (err) {
        if (!cancelled) {
          setConnected(false);
          setError(err instanceof Error ? err.message : 'Could not connect audio');
        }
      }
    })();

    const onDisconnected = () => {
      if (!cancelled) {
        setConnected(false);
        setRemoteMicMuted(null);
      }
    };

    const remoteEvents = [
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackPublished,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
    ] as const;

    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    for (const event of remoteEvents) {
      room.on(event, recomputeRemote);
    }

    return () => {
      cancelled = true;
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      for (const event of remoteEvents) {
        room.off(event, recomputeRemote);
      }
      void room.disconnect();
      roomRef.current = null;
      setConnected(false);
      setRemoteMicMuted(null);
    };
  }, [credentials?.sessionId, credentials?.token, credentials?.url, enabled]);

  return { connected, error, setTransmitting, remoteMicMuted };
}

export async function disconnectVoiceRoom(): Promise<void> {
  /* room cleanup is handled by the hook teardown */
}
