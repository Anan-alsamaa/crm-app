import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Spinner } from '@yiji/ui';
import { useAuth, isAdmin } from './AuthContext.js';

/** Gate admin routes: authenticated AND an admin role. */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={28} />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!isAdmin(user)) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-red-600">
        Your account does not have administrator access.
      </div>
    );
  }
  return <>{children}</>;
}
