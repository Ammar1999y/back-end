import { memo } from 'react';

import { TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface PermissionsTableHeaderProps {
  onToggleAllView: () => void;
  onToggleAllEdit: () => void;
  onToggleAllDelete: () => void;
  onToggleAllCreate: () => void;
}

const PermissionsTableHeader = memo(
  ({
    onToggleAllView,
    onToggleAllEdit,
    onToggleAllDelete,
    onToggleAllCreate,
  }: PermissionsTableHeaderProps) => {
    return (
      <TableHeader>
        <TableRow className='bg-accent/50 [&_th:first-child]:rounded-tr-lg [&_th:last-child]:rounded-tl-lg'>
          <TableHead className='py-5 font-normal'>اسم الصفحة</TableHead>
          <TableHead className='text-center font-semibold'>
            <div className='flex flex-col items-center'>
              <span>زيارة</span>
              <button
                type='button'
                onClick={onToggleAllView}
                className='mt-1 rounded-md text-xs text-muted-foreground transition-all duration-300 hover:text-foreground'
              >
                اختيار الكل
              </button>
            </div>
          </TableHead>
          <TableHead className='text-center font-semibold'>
            <div className='flex flex-col items-center'>
              <span>تعديل</span>
              <button
                type='button'
                onClick={onToggleAllEdit}
                className='mt-1 rounded-md text-xs text-muted-foreground transition-all duration-300 hover:text-foreground'
              >
                اختيار الكل
              </button>
            </div>
          </TableHead>
          <TableHead className='text-center font-semibold'>
            <div className='flex flex-col items-center'>
              <span>حذف</span>
              <button
                type='button'
                onClick={onToggleAllDelete}
                className='mt-1 rounded-md text-xs text-muted-foreground transition-all duration-300 hover:text-foreground'
              >
                اختيار الكل
              </button>
            </div>
          </TableHead>
          <TableHead className='text-center font-semibold'>
            <div className='flex flex-col items-center'>
              <span>إنشاء</span>
              <button
                type='button'
                onClick={onToggleAllCreate}
                className='mt-1 rounded-md text-xs text-muted-foreground transition-all duration-300 hover:text-foreground'
              >
                اختيار الكل
              </button>
            </div>
          </TableHead>
        </TableRow>
      </TableHeader>
    );
  }
);

PermissionsTableHeader.displayName = 'PermissionsTableHeader';
export default PermissionsTableHeader;
