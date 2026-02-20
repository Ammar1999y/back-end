import type { VariantProps } from 'class-variance-authority';

import NextLink from 'next/link';
import * as React from 'react';

import { cn } from '@/lib/utils';

import { buttonVariants } from './button';

export interface LinkProps
  extends
    React.ComponentPropsWithoutRef<'a'>,
    VariantProps<typeof buttonVariants> {
  replace?: boolean;
  ref?: React.Ref<HTMLAnchorElement>;
}

const Link = ({
  className,
  variant,
  replace = false,
  size,
  href,
  ref,
  ...props
}: LinkProps) => {
  return (
    <NextLink
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      href={href as string}
      replace={replace}
      {...props}
    />
  );
};
Link.displayName = 'Link';

export { Link };
