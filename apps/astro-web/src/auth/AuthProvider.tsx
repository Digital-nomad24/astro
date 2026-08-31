import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';

import { apiGet, apiPatch, setTokenProvider } from '../lib/api';
import { firebaseAuth, firebaseSignOut, getIdToken } from '../lib/firebase';
import {
  disconnectPresence,
  setSocketTokenProvider,
} from '../lib/socket';
import {
  disconnectCalls,
  setCallsTokenProvider,
} from '../lib/calls-socket';
import {
  disconnectChat,
  setChatTokenProvider,
} from '../lib/chat-socket';
import type { MeResponse } from '../types/api';

interface AuthContextValue {
  firebaseUser: User | null;
  me: MeResponse | null;
  loading: boolean;
  refreshMe: () => Promise<MeResponse | null>;
  signOut: () => Promise<void>;
  isOnboarded: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const tokenFn = useCallback(async () => {
    const user = firebaseAuth.currentUser;
    if (!user) return null;
    return getIdToken(user);
  }, []);

  useEffect(() => {
    setTokenProvider(tokenFn);
    setSocketTokenProvider(tokenFn);
    setCallsTokenProvider(tokenFn);
    setChatTokenProvider(tokenFn);
  }, [tokenFn]);

  const refreshMe = useCallback(async (): Promise<MeResponse | null> => {
    const user = firebaseAuth.currentUser;
    if (!user) {
      setMe(null);
      return null;
    }
    try {
      const profile = await apiGet<MeResponse>('/me');
      setMe(profile);
      return profile;
    } catch {
      setMe(null);
      return null;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
      setFirebaseUser(user);
      if (user) {
        await refreshMe();
      } else {
        setMe(null);
        disconnectPresence();
        disconnectCalls();
        disconnectChat();
      }
      setLoading(false);
    });
    return unsubscribe;
  }, [refreshMe]);

  const signOut = useCallback(async () => {
    disconnectPresence();
    disconnectCalls();
    disconnectChat();
    await firebaseSignOut();
    setMe(null);
    setFirebaseUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      firebaseUser,
      me,
      loading,
      refreshMe,
      signOut,
      isOnboarded: me?.onboardedAt != null,
    }),
    [firebaseUser, me, loading, refreshMe, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}

export async function updateMe(body: {
  displayName?: string;
  photoUrl?: string | null;
}): Promise<MeResponse> {
  return apiPatch<MeResponse>('/me', body);
}
