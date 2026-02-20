import type { NavItemDataProps } from '@/components/nav';

import Link from 'next/link';
import { useRouter } from 'next/router';
import * as React from 'react';
import { useMemo } from 'react';

import { ChevronDown as _ChevronDown } from 'lucide-react';

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { frontendNavData } from '../dashboard/nav/nav-data';

const ChevronDown = React.memo(_ChevronDown);

type NavItem = Pick<
  NavItemDataProps,
  'path' | 'title' | 'hideChildrenDropdown'
> & {
  children?: NavItem[];
};

interface BreadcrumbItemData {
  key: string;
  label: string;
  hideDropdown: boolean;
  items: Array<{
    key: string;
    label: string;
  }>;
}

export default React.memo(function BreadCrumb({
  maxItems = 3,
}: {
  maxItems?: number;
}) {
  const router = useRouter();

  const breadCrumbs = useMemo(() => {
    // Build paths from current pathname
    const pathname = router.pathname;
    const segments = pathname.split('/').filter(Boolean);

    // Create cumulative paths (e.g., /dashboard, /dashboard/users, /dashboard/users/edit)
    const paths = segments.map(
      (_, index) => '/' + segments.slice(0, index + 1).join('/')
    );

    const findPathInNavData = (path: string, items: NavItem[]): NavItem[] => {
      for (const item of items) {
        if (item.path === path) {
          return [item];
        }
        if (item.children) {
          const found = findPathInNavData(path, item.children);
          if (found.length > 0) {
            return [item, ...found];
          }
        }
      }
      return [];
    };

    return paths
      .map((path) => {
        const navItems = frontendNavData.flatMap((section) => section.items);
        const pathItems = findPathInNavData(path, navItems);

        if (pathItems.length === 0) return null;

        const currentItem = pathItems[pathItems.length - 1];
        const children =
          currentItem.children?.map((child) => ({
            key: child.path,
            label: child.title,
          })) ?? [];

        return {
          key: currentItem.path,
          label: currentItem.title,
          hideDropdown: currentItem.hideChildrenDropdown ?? false,
          items: children,
        };
      })
      .filter((item): item is BreadcrumbItemData => item !== null);
  }, [router.pathname]);

  const renderBreadcrumbItem = (item: BreadcrumbItemData, isLast: boolean) =>
    item.items && item.items.length > 0 && !item.hideDropdown ? (
      <BreadcrumbItem>
        <DropdownMenu>
          <DropdownMenuTrigger className='flex items-center rounded space-x-1'>
            <span>{item.label}</span>
            <ChevronDown className='h-4 w-4' />
          </DropdownMenuTrigger>
          <DropdownMenuContent align='start'>
            {item.items.map((subItem) => (
              <DropdownMenuItem key={subItem.key} asChild>
                <Link href={subItem.key}>{subItem.label}</Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </BreadcrumbItem>
    ) : (
      <BreadcrumbItem>
        {isLast ? (
          <BreadcrumbPage>{item.label}</BreadcrumbPage>
        ) : (
          <BreadcrumbLink href={item.key}>{item.label}</BreadcrumbLink>
        )}
      </BreadcrumbItem>
    );

  const renderBreadcrumbs = () => {
    if (breadCrumbs.length <= maxItems) {
      return breadCrumbs.map((item, index) => (
        <React.Fragment key={index}>
          {renderBreadcrumbItem(item, index === breadCrumbs.length - 1)}
          {index < breadCrumbs.length - 1 && <BreadcrumbSeparator />}
        </React.Fragment>
      ));
    }

    // Show first item, ellipsis, and last maxItems-1 items
    const firstItem = breadCrumbs[0];
    const lastItems = breadCrumbs.slice(-(maxItems - 1));
    const hiddenItems = breadCrumbs.slice(1, -(maxItems - 1));

    if (!firstItem) return null;

    return (
      <>
        {renderBreadcrumbItem(firstItem, false)}
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <DropdownMenu>
            <DropdownMenuTrigger className='flex items-center rounded space-x-1'>
              <BreadcrumbEllipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align='start'>
              {hiddenItems.map((item) => (
                <DropdownMenuItem key={item.key} asChild>
                  <Link href={item.key}>{item.label}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        {lastItems.map((item, index) => (
          <React.Fragment key={item.key}>
            {renderBreadcrumbItem(item, index === lastItems.length - 1)}
            {index < lastItems.length - 1 && <BreadcrumbSeparator />}
          </React.Fragment>
        ))}
      </>
    );
  };

  return (
    <Breadcrumb>
      <BreadcrumbList>{renderBreadcrumbs()}</BreadcrumbList>
    </Breadcrumb>
  );
});
