import type { TTableCellElement, TTableElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';
import type * as React from 'react';

import { BaseTablePlugin } from '@platejs/table';
import { SlateElement } from 'platejs/static';
import { cn } from '@/lib/utils';

export function TableElementStatic({
  children,
  ...props
}: SlateElementProps<TTableElement>) {
  const { disableMarginLeft } = props.editor.getOptions(BaseTablePlugin);
  const marginLeft = disableMarginLeft ? 0 : props.element.marginLeft;
  const element = props.element;

  return (
    <SlateElement
      {...props}
      className={cn('py-5', element.width !== 'full' && 'overflow-x-auto')}
      style={{ paddingLeft: marginLeft }}
    >
      <div
        className={cn(
          'group/table relative',
          element.width === 'full' ? 'w-full' : 'w-fit'
        )}
      >
        <table
          className={cn(
            'me-0 table h-px table-fixed border-collapse',
            element.width === 'full' && 'w-full'
          )}
        >
          <tbody className='min-w-full'>{children}</tbody>
        </table>
      </div>
    </SlateElement>
  );
}

export function TableRowElementStatic(props: SlateElementProps) {
  return (
    <SlateElement {...props} as='tr' className='h-full'>
      {props.children}
    </SlateElement>
  );
}

export function TableCellElementStatic({
  isHeader,
  ...props
}: SlateElementProps<TTableCellElement> & {
  isHeader?: boolean;
}) {
  const { editor, element } = props;
  const { api } = editor.getPlugin(BaseTablePlugin);

  const { minHeight, width } = api.table.getCellSize({ element });
  const borders = api.table.getCellBorders({ element });

  return (
    <SlateElement
      {...props}
      as={isHeader ? 'th' : 'td'}
      attributes={{
        ...props.attributes,
        colSpan: api.table.getColSpan(element),
        rowSpan: api.table.getRowSpan(element),
      }}
      className={cn(
        'h-full overflow-visible border-none bg-background p-0',
        element.background ? 'bg-[--cellBackground]' : 'bg-background',
        isHeader && 'text-left font-normal *:m-0',
        'before:size-full',
        "before:absolute before:box-border before:select-none before:content-['']",
        borders &&
          cn(
            borders.bottom?.size && 'before:border-b before:border-b-border',
            borders.right?.size && 'before:border-e before:border-e-border',
            borders.left?.size && 'before:border-s before:border-s-border',
            borders.top?.size && 'before:border-t before:border-t-border'
          )
      )}
      style={
        {
          '--cellBackground': element.background,
          maxWidth: width || 240,
          minWidth: width || 120,
        } as React.CSSProperties
      }
    >
      <div
        className='relative z-20 box-border h-full px-4 py-2'
        style={{ minHeight }}
      >
        {props.children}
      </div>
    </SlateElement>
  );
}

export function TableCellHeaderElementStatic(
  props: SlateElementProps<TTableCellElement>
) {
  return <TableCellElementStatic {...props} isHeader />;
}
