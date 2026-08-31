import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import {
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
} from '../lib/firebase';
import { homePathForMe } from '../lib/roles';

export function SignInPage() {
  const navigate = useNavigate();
  const { refreshMe } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function afterAuth() {
    const me = await refreshMe();
    navigate(homePathForMe(me), { replace: true });
  }

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isSignUp) {
        await signUpWithEmail(email, password);
      } else {
        await signInWithEmail(email, password);
      }
      await afterAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setBusy(true);
    try {
      await signInWithGoogle();
      await afterAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-hero">
        <p className="eyebrow">Mentor consultations</p>
        <h1>Astro</h1>
        <p className="lead">
          Live guidance from people who have been there — voice and text, billed by the minute.
        </p>
      </div>
      <div className="auth-panel">
        <h2>{isSignUp ? 'Create account' : 'Sign in'}</h2>
        {error && <p className="error-banner">{error}</p>}
        <form onSubmit={(e) => void handleEmailSubmit(e)}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
            />
          </label>
          <button type="submit" className="btn primary full" disabled={busy}>
            {busy ? 'Please wait…' : isSignUp ? 'Sign up' : 'Sign in'}
          </button>
        </form>
        <div className="auth-divider">or</div>
        <button
          type="button"
          className="btn secondary full"
          onClick={() => void handleGoogle()}
          disabled={busy}
        >
          Continue with Google
        </button>
        <p className="auth-toggle">
          {isSignUp ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => setIsSignUp((v) => !v)}
          >
            {isSignUp ? 'Sign in' : 'Create account'}
          </button>
        </p>
      </div>
    </div>
  );
}
