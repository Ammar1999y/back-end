import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { useShallow } from 'zustand/shallow';
import { useSession } from '@/lib/auth/use-session';
import { cn } from '@/lib/utils';

import { useSettingStore } from '@/utils/store/setting';

import { down, useMediaQuery } from '@/hooks/use-media-query';
import Logo from '@/components/logo';
import { ThemeLayout } from '@/components/theme-customizer/types/enum';

import Header from './header';
import Main from './main';
import { NavHorizontalLayout, NavMobileLayout, NavVerticalLayout } from './nav';
import { frontendNavData } from './nav/nav-data';

const navData = frontendNavData;
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const isMobile = useMediaQuery(down('md2'));
  const { replace, asPath } = useRouter();
  const { data: session, isPending } = useSession();
  useEffect(() => {
    if (!isPending && !session?.user?.id) {
      replace('/dash/sign-in');
      localStorage.setItem('redirect-path', asPath);
    }
  }, [session?.user?.id, replace, isPending, asPath]);
  if (isPending || !session?.user?.id) return null;
  return (
    <div
      data-slot='slash-layout-root'
      className='min-h-screen w-full bg-background'
    >
      {isMobile ? (
        <MobileLayout>{children}</MobileLayout>
      ) : (
        <PcLayout>{children}</PcLayout>
      )}
    </div>
  );
}

function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Sticky Header */}
      <Header leftSlot={<NavMobileLayout data={navData} />} />
      <Main>{children}</Main>
    </>
  );
}

function PcLayout({ children }: { children: React.ReactNode }) {
  const themeLayout = useSettingStore(
    useShallow((s) => s.settings.themeLayout)
  );

  if (themeLayout === ThemeLayout.Horizontal)
    return <PcHorizontalLayout>{children}</PcHorizontalLayout>;
  return <PcVerticalLayout>{children}</PcVerticalLayout>;
}

function PcHorizontalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Sticky Header */}
      <Header leftSlot={<Logo size={50} className='h-full max-w-16' />} />
      {/* Sticky Nav */}
      <NavHorizontalLayout data={navData} />

      <Main>{children}</Main>
    </>
  );
}

function PcVerticalLayout({ children }: { children: React.ReactNode }) {
  const themeLayout = useSettingStore(
    useShallow((s) => s.settings.themeLayout)
  );

  return (
    <>
      {/* Fixed Header */}
      <NavVerticalLayout data={navData} />

      <div
        className={cn(
          'relative flex min-h-screen w-full flex-col transition-[padding] duration-300 ease-in-out',
          themeLayout === ThemeLayout.Vertical
            ? 'rtl:ps-[--layout-nav-width]'
            : 'rtl:ps-[--layout-nav-width-mini]'
        )}
      >
        <Header />
        <Main>{children}</Main>
      </div>
    </>
  );
}
