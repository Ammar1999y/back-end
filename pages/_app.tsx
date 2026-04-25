import 'lenis/dist/lenis.css';
import '@/styles/globals.css';
import '@/components/theme-customizer/circular-transition.css';
import '@/styles/app-style.css';
import '@/styles/icons.css';
import '@/styles/table.css';
// Import local storage handlers to register them

import type { AppProps } from 'next/app';

import { NextComponentType, NextPageContext } from 'next';
import dynamic from 'next/dynamic';
import { Cairo } from 'next/font/google';
import { useEffect, useMemo } from 'react';

import { DirectionProvider } from '@radix-ui/react-direction';

import { useModules } from '@/utils/store/modules';

import useIsomorphicLayoutEffect from '@/hooks/use-layout-effect';
import ErrorPage from '@/components/error-page';
import HeadComponent, { StaticHead } from '@/components/head';
import DashboardLayout from '@/components/layouts/dashboard';
import ProgressProvider from '@/components/providers/progress';
import ReactQueryProvider from '@/components/providers/react-query';
import { ThemeProvider } from '@/components/theme-customizer/theme-provider';

// const SmoothScroll = dynamic(() => import('@/components/smoth-scroll'), {
//   ssr: false,
// });

const GlobalModules = dynamic(() => import('@/components/modules'), {
  ssr: false,
});

const Toaster = dynamic(() => import('@/components/toaster'), {
  ssr: false,
});

const myFont = Cairo({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});
interface ComponentProps extends AppProps {
  Component: NextComponentType<NextPageContext, any, any> & {
    hideSidebar?: boolean;
  };
}

const App = ({ Component, pageProps, router }: ComponentProps) => {
  const {
    pathname = '',
    description = '',
    serverError = false,
    title: _title,
  } = pageProps;

  const title = useMemo(
    () => ({
      default: _title?.default || 'البيت التقني',
      template: _title?.template,
    }),
    [_title]
  );

  useIsomorphicLayoutEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    router.beforePopState((state) => {
      state.options.scroll = false;
      return true;
    });
  }, [router]);

  useEffect(() => {
    const handleResize = () =>
      useModules.getState().setShowDrawer(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);
  const hideSidebar = Component.hideSidebar;
  if (serverError) return <ErrorPage />;
  return (
    <ReactQueryProvider>
      <DirectionProvider dir={'rtl'}>
        <style jsx global>{`
          :root {
            --font-main: ${myFont.style.fontFamily};
          }
        `}</style>
        <StaticHead />
        <HeadComponent
          currentLocale={'ar'}
          pathname={pathname}
          title={title}
          description={description}
        />

        {/* <SmoothScroll /> */}
        <ThemeProvider>
          <Toaster />
          <GlobalModules />
          <ProgressProvider dir='rtl'>
            <Layout hideSidebar={!!hideSidebar}>
              <Component {...pageProps} />
            </Layout>
          </ProgressProvider>
        </ThemeProvider>
      </DirectionProvider>
    </ReactQueryProvider>
  );
};

export default App;

const Layout = ({
  children,
  hideSidebar,
}: {
  children: React.ReactNode;
  hideSidebar: boolean;
}) =>
  hideSidebar ? <>{children}</> : <DashboardLayout>{children}</DashboardLayout>;
