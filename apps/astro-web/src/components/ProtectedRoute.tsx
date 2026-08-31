import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { homePathForMe, homePathForRole, isSeekerRole } from '../lib/roles';

export function ProtectedRoute() {
  const { firebaseUser, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="page-center">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!firebaseUser) {
    return <Navigate to="/sign-in" state={{ from: location }} replace />;
  }

  return <Outlet />;
}

export function OnboardedRoute() {
  const { isOnboarded, loading } = useAuth();

  if (loading) {
    return (
      <div className="page-center">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!isOnboarded) {
    return <Navigate to="/onboard" replace />;
  }

  return <Outlet />;
}

/** Browse / mentor detail / apply — seekers only. Mentors go to desk. */
export function SeekerRoute() {
  const { me, loading } = useAuth();

  if (loading) {
    return (
      <div className="page-center">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!isSeekerRole(me?.role)) {
    return <Navigate to={homePathForRole(me?.role)} replace />;
  }

  return <Outlet />;
}

export function GuestRoute() {
  const { firebaseUser, me, isOnboarded, loading } = useAuth();

  if (loading) {
    return (
      <div className="page-center">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (firebaseUser) {
    return <Navigate to={isOnboarded ? homePathForMe(me) : '/onboard'} replace />;
  }

  return <Outlet />;
}
