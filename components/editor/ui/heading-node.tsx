'use client';

import type { VariantProps } from 'class-variance-authority';
import type { PlateElementProps } from 'platejs/react';

import { cva } from 'class-variance-authority';
import { PlateElement } from 'platejs/react';

const headingVariants = cva('relative mb-1', {
  variants: {
    variant: {
      h1: 'mt-6 pb-1 font-bold font-heading text-4xl',
      h2: 'mt-5 pb-px font-heading font-semibold text-2xl tracking-tight',
      h3: 'mt-4 pb-px font-heading font-semibold text-xl tracking-tight',
      h4: 'mt-3 font-heading font-semibold text-lg tracking-tight',
      h5: 'mt-2 font-semibold text-lg tracking-tight',
      h6: 'mt-2 font-semibold text-base tracking-tight',
    },
  },
});

export function HeadingElement({
  variant = 'h1',
  ...props
}: PlateElementProps & VariantProps<typeof headingVariants>) {
  return (
    <PlateElement
      as={variant!}
      className={headingVariants({ variant })}
      {...props}
      // @ts-ignore
      attributes={{
        ...props.attributes,
        'data-ltr-element': true,
      }}
    >
      {props.children}
    </PlateElement>
  );
}

export function H1Element(props: PlateElementProps) {
  return <HeadingElement variant='h1' {...props} />;
}

export function H2Element(props: PlateElementProps) {
  return <HeadingElement variant='h2' {...props} />;
}

export function H3Element(props: PlateElementProps) {
  return <HeadingElement variant='h3' {...props} />;
}

export function H4Element(props: PlateElementProps) {
  return <HeadingElement variant='h4' {...props} />;
}

export function H5Element(props: PlateElementProps) {
  return <HeadingElement variant='h5' {...props} />;
}

export function H6Element(props: PlateElementProps) {
  return <HeadingElement variant='h6' {...props} />;
}
