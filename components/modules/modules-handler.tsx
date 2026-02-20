import { usePathname } from 'next/navigation';
import { useRouter } from 'next/router';
import { memo, useEffect, useRef } from 'react';

import { useShallow } from 'zustand/shallow';

import { useModules } from '@/utils/store/modules';

import { MODULE_ID as MOBILE_MENU_MODULE_ID } from '../layouts/dashboard/nav';
import { MODULE_ID as THEME_MODULE_ID } from '../theme-customizer';
import { MODULE_ID as IMAGE_MODULE_ID } from './image-zoom';

export const modulesNames = [
  IMAGE_MODULE_ID,
  THEME_MODULE_ID,
  MOBILE_MENU_MODULE_ID,
] as const;
export type ModulesNames = (typeof modulesNames)[number];

export const VALID_MODULES = new Set<ModulesNames>(modulesNames);

export function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
export function buildUrlWithModules(nextOpenModules: ModulesNames[]): string {
  const url = new URL(location.href);
  url.searchParams.delete('module');

  dedupe(nextOpenModules)
    .filter((m) => VALID_MODULES.has(m))
    .forEach((m) => url.searchParams.append('module', m));

  return `${url.pathname}${url.search}${url.hash}`;
}
const ModulesHandler = memo(() => {
  const openModules = useModules(useShallow((state) => state.openModules));
  const prevModulesRef = useRef<ModulesNames[]>([]);
  const isHandlingPopStateRef = useRef(false);
  const initialized = useRef(false);
  const router = useRouter();
  const pathname = usePathname();

  const prevPathnameRef = useRef<string>(
    typeof window !== 'undefined' ? location.pathname : ''
  );
  const { locale } = router;
  const prevLocaleRef = useRef<string | undefined>(locale);

  // open modules from url in the first init
  useEffect(() => {
    if (typeof window === 'undefined' || initialized.current || !router.isReady)
      return;
    try {
      const url = new URL(location.href);
      const urlModules = url.searchParams
        .getAll('module')
        .filter((m) => VALID_MODULES.has(m as ModulesNames));
      queueMicrotask(() => {
        const { openModules, addModule } = useModules.getState();
        initialized.current = true;
        if (urlModules.length > 0 && !openModules?.length) {
          url.searchParams.delete('module');
          try {
            history.replaceState(null, '', url);
          } catch {}
          dedupe(urlModules).forEach((m) =>
            setTimeout(() => {
              addModule(m as ModulesNames);
            }, 100)
          );
        }
      });
    } catch {
      initialized.current = true;
    }
  }, [router.isReady]);

  // close modules when user goes back in history
  useEffect(() => {
    const handlePopState = () => {
      if (isHandlingPopStateRef.current) return;
      isHandlingPopStateRef.current = true;

      const url = new URL(location.href);
      const currentUrl = `${url.pathname}${url.search}${url.hash}`;

      const target = dedupe<ModulesNames>(
        url.searchParams
          .getAll('module')
          .filter((m) => VALID_MODULES.has(m as ModulesNames)) as ModulesNames[]
      );

      useModules.getState().setOpenModules(target);
      prevModulesRef.current = target;

      const cleanUrl = buildUrlWithModules(target);
      if (currentUrl !== cleanUrl) history.replaceState(null, '', cleanUrl);

      setTimeout(() => {
        isHandlingPopStateRef.current = false;
      }, 100);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // close modules when user clicks on link in the modules
  useEffect(() => {
    if (
      prevPathnameRef.current === pathname &&
      prevLocaleRef.current === locale
    )
      return;

    useModules.getState().resetModules();
    prevPathnameRef.current = pathname || '';
    prevLocaleRef.current = locale;
  }, [pathname, locale]);

  // manage the url
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      isHandlingPopStateRef.current ||
      !initialized.current
    )
      return;

    const nextUrl = buildUrlWithModules(openModules);
    const currentUrl = `${location.pathname}${location.search}${location.hash}`;
    if (openModules.length > prevModulesRef.current.length) {
      history.pushState(null, '', nextUrl);
    } else if (
      openModules.length < prevModulesRef.current.length &&
      currentUrl !== nextUrl
    ) {
      isHandlingPopStateRef.current = true;
      history.replaceState(null, '', nextUrl);

      // history.back();
      setTimeout(() => {
        isHandlingPopStateRef.current = false;
      }, 100);
    }
    prevModulesRef.current = dedupe(openModules);
  }, [openModules]);

  return null;
});

ModulesHandler.displayName = 'ModulesHandler';

export default ModulesHandler;
