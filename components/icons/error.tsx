import { memo } from 'react';

export const ErrorIcon = memo(() => {
  return (
    <div className='rounded-lg bg-error/10 p-2'>
      <div className='error-icon' />
    </div>
  );
});

ErrorIcon.displayName = 'ErrorIcon';
