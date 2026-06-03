import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Spinner } from '@yiji/ui';
import { useAuth } from './AuthContext.js';

/**
 * Gate routes behind authentication. The agent portal additionally requires the
 * user's role to be Agent or Administrator (admins may inspect the agent view).
 */
const ALLOWED_ROLES = ['Agent', 'Administrator', 'Admin'];

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
  if (user.role && !ALLOWED_ROLES.includes(user.role.name)) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-red-600">
        Your role does not have access to the Agent Portal.
      </div>
    );
  }
  return <>{children}</>;
}
