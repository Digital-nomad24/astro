import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider, useAuth } from './auth/AuthProvider';
import { CallProvider } from './call/CallProvider';
import { CallOverlay } from './components/CallOverlay';
import { Layout } from './components/Layout';
import {
  GuestRoute,
  OnboardedRoute,
  ProtectedRoute,
  SeekerRoute,
} from './components/ProtectedRoute';
import { homePathForRole, isAdminRole, isMentorRole } from './lib/roles';
import { AdminPage } from './pages/AdminPage';
import { ApplyPage } from './pages/ApplyPage';
import { BrowsePage } from './pages/BrowsePage';
import { HistoryPage } from './pages/HistoryPage';
import { MentorDeskPage } from './pages/MentorDeskPage';
import { MentorDetailPage } from './pages/MentorDetailPage';
import { OnboardPage } from './pages/OnboardPage';
import { SignInPage } from './pages/SignInPage';
import { TranscriptPage } from './pages/TranscriptPage';

function HomeRedirect() {
  const { me, firebaseUser, isOnboarded, loading } = useAuth();
  if (loading) return <p className="muted center">Loading…</p>;
  if (!firebaseUser) return <Navigate to="/sign-in" replace />;
  if (!isOnboarded) return <Navigate to="/onboard" replace />;
  return <Navigate to={homePathForRole(me?.role)} replace />;
}

function AdminRoute() {
  const { me, loading } = useAuth();
  if (loading) return <p className="muted center">Loading…</p>;
  if (!isAdminRole(me?.role)) return <Navigate to={homePathForRole(me?.role)} replace />;
  return <AdminPage />;
}

function MentorDeskRoute() {
  const { me, loading } = useAuth();
  if (loading) return <p className="muted center">Loading…</p>;
  if (!isMentorRole(me?.role)) {
    return <Navigate to="/apply" replace />;
  }
  return <MentorDeskPage />;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CallProvider>
          <Routes>
          <Route element={<GuestRoute />}>
            <Route path="/sign-in" element={<SignInPage />} />
          </Route>

          <Route element={<ProtectedRoute />}>
            <Route path="/onboard" element={<OnboardPage />} />
            <Route element={<OnboardedRoute />}>
              <Route element={<Layout />}>
                <Route path="/" element={<HomeRedirect />} />
                <Route element={<SeekerRoute />}>
                  <Route path="/browse" element={<BrowsePage />} />
                  <Route path="/mentors/:id" element={<MentorDetailPage />} />
                  <Route path="/apply" element={<ApplyPage />} />
                </Route>
                {/* Outside SeekerRoute: both sides of a consultation have a history, and a
                    mentor reading theirs is the whole point of the `as=mentor` listing. */}
                <Route path="/history" element={<HistoryPage />} />
                <Route path="/history/:id" element={<TranscriptPage />} />
                <Route path="/desk" element={<MentorDeskRoute />} />
                <Route path="/admin" element={<AdminRoute />} />
              </Route>
            </Route>
          </Route>

          <Route path="*" element={<HomeRedirect />} />
          </Routes>
          <CallOverlay />
        </CallProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
