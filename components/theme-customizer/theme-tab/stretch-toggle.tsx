import { memo } from 'react';

import { CircleQuestionMark as _CircleQuestionMark } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import Label from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { useEditorStore } from '../store/editor-store';

const CircleQuestionMark = memo(_CircleQuestionMark);
CircleQuestionMark.displayName = 'CircleQuestionMark';

const StretchToggle = memo(
  ({ containerStretch }: { containerStretch: boolean }) => {
    const setContainerStretch = useEditorStore(
      useShallow((s) => s.setContainerStretch)
    );
    return (
      <div className='flex flex-row items-center justify-between'>
        <Tooltip
          delayDuration={700}
          defaultOpen={false}
          disableHoverableContent
        >
          <TooltipTrigger className='cursor-default'>
            <div className='flex items-center'>
              <Label
                className='mb-0 font-medium'
                title='توسيع'
                htmlFor='container-stretch'
              />
              <CircleQuestionMark
                className='ms-1 mt-1 size-4 opacity-60'
                size={14}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent>تمديد المحتوى إلى كامل العرض</TooltipContent>
        </Tooltip>
        <Switch
          id='container-stretch'
          checked={containerStretch}
          onCheckedChange={setContainerStretch}
        />
      </div>
    );
  }
);

StretchToggle.displayName = 'StretchToggle';

export { StretchToggle };
