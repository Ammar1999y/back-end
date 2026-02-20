import { authClient } from '@/lib/auth/client';

export const useSession = () => {
  if (typeof window === 'undefined') {
    return {
      data: null,
      isPending: true,
      error: null,
    };
  }
  return authClient.useSession();
};
