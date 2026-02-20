import { useState } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CustomError } from '@/utils/error-class';

const ReactQueryProvider = ({ children }: { children: React.ReactNode }) => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: true,
            refetchOnMount: true,
            refetchOnReconnect: true,
            retry: (failureCount, error) => {
              const isDev = process.env.NODE_ENV === 'development';
              if (error instanceof CustomError && failureCount < 5 && !isDev) {
                const status = error.status;
                return !!status && status >= 500;
              }
              return false;
            },
            retryDelay: (attemptIndex) =>
              Math.min(1000 * 2 ** attemptIndex, 7000),
            staleTime: 30 * 60 * 1000,
            gcTime: 20 * 60 * 1000,
          },
          // mutations: {
          //   onError: (error) => {
          //     if (error instanceof AxiosError) {
          //       if (error.response?.status === 304) {
          //         toast.error('Content not modified!');
          //       }
          //     }
          //   },
          // },
        },
        // queryCache: new QueryCache({
        //   onError: (error) => {
        //     if (error instanceof AxiosError) {
        //       if (error.response?.status === 401) {
        //         toast.error('Session expired!');
        //         useAuthStore.getState().auth.reset();
        //         const redirect = `${router.history.location.href}`;
        //         router.navigate({ to: '/sign-in', search: { redirect } });
        //       }
        //       if (error.response?.status === 500) {
        //         toast.error('Internal Server Error!');
        //         router.navigate({ to: '/500' });
        //       }
        //       if (error.response?.status === 403) {
        //         // router.navigate("/forbidden", { replace: true });
        //       }
        //     }
        //   },
        // }),
      })
  );
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

export default ReactQueryProvider;
