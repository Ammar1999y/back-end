import { memo } from 'react';

const ToolbarSkeleton = memo(() => {
  return (
    <div className='flex w-full animate-pulse items-center justify-start gap-2 p-1'>
      {/* Search */}
      <div className='h-9 w-48 rounded-md bg-accent'></div>
      {/* Sort button */}
      <div className='h-9 w-20 rounded-md bg-accent'></div>
      {/* Filter button */}
      <div className='h-9 w-20 rounded-md bg-accent'></div>
      {/* View options */}
      <div className='flex flex-1 justify-end'>
        <div className='h-9 w-24 rounded-md bg-accent'></div>
      </div>
    </div>
  );
});

ToolbarSkeleton.displayName = 'ToolbarSkeleton';
export { ToolbarSkeleton };
