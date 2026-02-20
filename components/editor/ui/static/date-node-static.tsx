import type { TDateElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

export function DateElementStatic(props: SlateElementProps<TDateElement>) {
  const { element } = props;

  return (
    <SlateElement className='inline-block' {...props}>
      <span className='w-fit rounded-sm bg-muted px-1 text-muted-foreground'>
        {element.date ? (
          (() => {
            const today = new Date();
            const elementDate = new Date(element.date);
            const isToday =
              elementDate.getDate() === today.getDate() &&
              elementDate.getMonth() === today.getMonth() &&
              elementDate.getFullYear() === today.getFullYear();

            const isYesterday =
              new Date(today.setDate(today.getDate() - 1)).toDateString() ===
              elementDate.toDateString();
            const isTomorrow =
              new Date(today.setDate(today.getDate() + 2)).toDateString() ===
              elementDate.toDateString();

            if (isToday) return 'اليوم';
            if (isYesterday) return 'أمس';
            if (isTomorrow) return 'غداً';

            return elementDate.toLocaleDateString('en-US', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            });
          })()
        ) : (
          <span>اختر تاريخ</span>
        )}
      </span>
      {props.children}
    </SlateElement>
  );
}
