import { useRef } from 'react';

import { authClient } from '@/lib/auth/client';

export const useSession = () => {
  const hasResolved = useRef(false);
  if (typeof window === 'undefined') {
    return {
      data: null,
      error: null,
      isPending: true,
      isRefetching: true,
      refetch: () => void 0,
    };
  }

  const session = authClient.useSession();

  if (!session.isPending) hasResolved.current = true;

  return {
    ...session,
    isPending: hasResolved.current ? false : session.isPending,
  };
};
