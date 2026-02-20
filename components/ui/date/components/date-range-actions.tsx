import { memo } from 'react';

import { Button } from '@/components/ui/button';

interface DateRangeActionsProps {
  onCancel: () => void;
  onSave: () => void;
}

export const DateRangeActions = memo<DateRangeActionsProps>(
  ({ onCancel, onSave }) => (
    <div className='flex justify-end pb-2 pr-4 pt-4 space-x-2'>
      <Button onClick={onCancel} variant='ghost'>
        الغاء
      </Button>
      <Button onClick={onSave}>حفظ</Button>
    </div>
  )
);

DateRangeActions.displayName = 'DateRangeActions';
