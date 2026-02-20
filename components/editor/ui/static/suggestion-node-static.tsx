import type { TSuggestionText } from 'platejs';
import type { SlateLeafProps } from 'platejs/static';

import { BaseSuggestionPlugin } from '@platejs/suggestion';
import { SlateLeaf } from 'platejs/static';
import { cn } from '@/lib/utils';

export function SuggestionLeafStatic(props: SlateLeafProps<TSuggestionText>) {
  const { editor, leaf } = props;
  //  لعرض التغيرات عند تحويل المحتوى
  // حاليا لا يتم اظهار اي شي
  const dataList = editor
    .getApi(BaseSuggestionPlugin)
    .suggestion.dataList(leaf);
  const hasRemove = dataList.some((data) => data.type === 'remove');
  const diffOperation = { type: hasRemove ? 'delete' : 'insert' } as const;

  const Component = 'span';
  // const Component = ({ delete: 'del', insert: 'ins', update: 'span' } as const)[
  //   diffOperation.type
  // ];
  if (diffOperation.type === 'insert') return null;
  return (
    <SlateLeaf
      {...props}
      as={Component}
      className={cn(
        // 'border-b-2 border-b-primary/[.24] bg-primary/[.08] text-primary/80 no-underline transition-colors duration-200'
        'bg-primary/[.08] text-primary/80 no-underline transition-colors duration-200'
        // hasRemove &&
        //   'border-b-gray-300 bg-gray-300/25 text-gray-400 line-through'
      )}
    >
      {props.children}
    </SlateLeaf>
  );
}
