import { createContext, useContext } from 'react';

type SessionAccess = { authenticated: boolean; refreshSession: () => void };

export const SessionAccessContext = createContext<SessionAccess | null>(null);

export function useSessionAccess() {
  const access = useContext(SessionAccessContext);
  if (!access) throw new Error('Session access requires SessionGate');
  return access;
}
