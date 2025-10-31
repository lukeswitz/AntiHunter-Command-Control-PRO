import { PropsWithChildren, useEffect } from 'react';

import { useAuthStore } from '../stores/auth-store';

export function AuthProvider({ children }: PropsWithChildren) {
  const initialize = useAuthStore((state) => state.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  return <>{children}</>;
}
