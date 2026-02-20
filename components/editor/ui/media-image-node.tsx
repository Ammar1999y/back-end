'use client';

import type { TImageElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';

import { useDraggable } from '@platejs/dnd';
import { Image, ImagePlugin, useMediaState } from '@platejs/media/react';
import { ResizableProvider, useResizableValue } from '@platejs/resizable';
import { PlateElement, withHOC } from 'platejs/react';
import { cn } from '@/lib/utils';

import { Caption, CaptionTextarea } from './caption';
import { MediaToolbar } from './media-toolbar';
import {
  mediaResizeHandleVariants,
  Resizable,
  ResizeHandle,
} from './resize-handle';

export const ImageElement = withHOC(
  ResizableProvider,
  function ImageElement(props: PlateElementProps<TImageElement>) {
    const { align = 'center', focused, readOnly, selected } = useMediaState();
    const width = useResizableValue('width');

    const { isDragging, handleRef } = useDraggable({
      element: props.element,
    });

    // Calculate flip transform
    const flipHorizontal = props.element.flipHorizontal;
    const flipVertical = props.element.flipVertical;
    const flipTransform = `scaleX(${flipHorizontal ? -1 : 1}) scaleY(${flipVertical ? -1 : 1})`;

    return (
      <MediaToolbar plugin={ImagePlugin}>
        <PlateElement
          {...props}
          // @ts-ignore
          attributes={{
            ...props.attributes,
            'data-ltr-element': true,
          }}
          className='py-2.5'
        >
          <figure className='group relative m-0' contentEditable={false}>
            <Resizable
              align={align}
              options={{
                align,
                readOnly,
              }}
            >
              <ResizeHandle
                className={mediaResizeHandleVariants({ direction: 'left' })}
                options={{ direction: 'left' }}
              />
              <Image
                alt={props.attributes.alt as string | undefined}
                className={cn(
                  'block w-full max-w-full cursor-pointer object-cover px-0',
                  'rounded-sm',
                  focused && selected && 'ring-2 ring-ring ring-offset-2',
                  isDragging && 'opacity-50'
                )}
                ref={handleRef}
                style={{
                  transform: flipTransform,
                }}
              />
              <ResizeHandle
                className={mediaResizeHandleVariants({
                  direction: 'right',
                })}
                options={{ direction: 'right' }}
              />
            </Resizable>

            <Caption align={align} style={{ width }}>
              <CaptionTextarea
                onFocus={(e) => {
                  e.preventDefault();
                }}
                placeholder='Write a caption...'
                readOnly={readOnly}
              />
            </Caption>
          </figure>

          {props.children}
        </PlateElement>
      </MediaToolbar>
    );
  }
);
