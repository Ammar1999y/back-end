import type { TCaptionProps, TImageElement, TResizableProps } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { NodeApi } from 'platejs';
import { SlateElement } from 'platejs/static';
import { cn } from '@/lib/utils';

export function ImageElementStatic(
  props: SlateElementProps<TImageElement & TCaptionProps & TResizableProps>
) {
  const {
    align = 'center',
    caption,
    flipHorizontal,
    flipVertical,
    url,
    width,
  } = props.element;

  const flipTransform = `scaleX(${flipHorizontal ? -1 : 1}) scaleY(${flipVertical ? -1 : 1})`;

  return (
    <SlateElement {...props} className='py-2.5'>
      <figure
        className={cn(
          'group m-0 block max-w-full',
          align === 'center'
            ? 'mx-auto'
            : align === 'right'
              ? 'ms-auto'
              : 'me-auto'
        )}
        style={{ width }}
      >
        <div className='relative min-w-24 max-w-full'>
          <img
            alt={(props.attributes as any).alt}
            className={cn(
              'w-full max-w-full cursor-default object-cover px-0',
              'rounded-sm'
            )}
            src={url}
            style={{ transform: flipTransform }}
          />
          {caption && (
            <figcaption className='mx-auto mt-2 h-6 max-w-full'>
              {NodeApi.string(caption[0])}
            </figcaption>
          )}
        </div>
      </figure>
      {props.children}
    </SlateElement>
  );
}
