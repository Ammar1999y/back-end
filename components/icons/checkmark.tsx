import { memo } from 'react';

export const CheckmarkIcon = memo(() => {
  return (
    <div className='rounded-lg bg-success/10 p-2'>
      <div className='checkmark-icon' />
    </div>
  );
});
CheckmarkIcon.displayName = 'CheckmarkIcon';
