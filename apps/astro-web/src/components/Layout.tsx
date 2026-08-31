import { Link, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import {
  homePathForRole,
  isAdminRole,
  isMentorRole,
  isSeekerRole,
} from '../lib/roles';

export function Layout() {
  const { me, signOut } = useAuth();
  const location = useLocation();

  const seeker = isSeekerRole(me?.role);
  const mentor = isMentorRole(me?.role);
  const admin = isAdminRole(me?.role);
  const home = homePathForRole(me?.role);

  return (
    <div className="app-shell">
      <header className="site-header">
        <Link to={home} className="brand">
          Astro
        </Link>
        <nav className="site-nav">
          {seeker && (
            <Link
              to="/browse"
              className={
                location.pathname.startsWith('/browse') ||
                location.pathname.startsWith('/mentors')
                  ? 'active'
                  : ''
              }
            >
              Mentors
            </Link>
          )}
          {mentor && (
            <Link to="/desk" className={location.pathname === '/desk' ? 'active' : ''}>
              Desk
            </Link>
          )}
          {/* Everyone: a mentor's consultations are as much theirs as a seeker's are. */}
          <Link
            to="/history"
            className={location.pathname.startsWith('/history') ? 'active' : ''}
          >
            Consultations
          </Link>
          {seeker && (
            <Link to="/apply" className={location.pathname === '/apply' ? 'active' : ''}>
              Become a mentor
            </Link>
          )}
          {admin && (
            <Link to="/admin" className={location.pathname === '/admin' ? 'active' : ''}>
              Admin
            </Link>
          )}
        </nav>
        <div className="header-actions">
          {me?.displayName && <span className="user-name">{me.displayName}</span>}
          <button type="button" className="btn ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="site-main">
        <Outlet />
      </main>
    </div>
  );
}
