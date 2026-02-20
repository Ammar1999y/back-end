import type { PermissionsTableProps } from './types';

import { memo, useMemo } from 'react';

import {
  DASHBOARD_PAGES,
  DEFAULT_PAGE_PERMISSIONS,
  getAvailablePermissions,
  PERMISSION_ACTIONS,
  PermissionAction,
} from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

import PermissionsChangeHandler from './permissions-change-handler';
import PermissionsTableCell from './permissions-table-cell';
import PermissionsTableHeader from './permissions-table-header';
import { usePermissionsTable } from './use-permissions-table';

const PermissionsTable = memo(
  ({
    onPermissionsChange,
    className,
    setInitPermissions,
  }: PermissionsTableProps) => {
    const permissionActions = useMemo(
      () => Object.keys(PERMISSION_ACTIONS) as PermissionAction[],
      []
    );
    const {
      toggleAllView,
      toggleAllEdit,
      toggleAllDelete,
      toggleAllCreate,
      toggleRowAll,
    } = usePermissionsTable(setInitPermissions);
    return (
      <>
        <PermissionsChangeHandler onPermissionsChange={onPermissionsChange} />
        <Table
          className='w-full min-w-96'
          containerClassName={cn('rounded-md overflow-y-hidden', className)}
        >
          <PermissionsTableHeader
            onToggleAllView={toggleAllView}
            onToggleAllEdit={toggleAllEdit}
            onToggleAllDelete={toggleAllDelete}
            onToggleAllCreate={toggleAllCreate}
          />
          <tbody aria-hidden='true' className='h-2' />
          <TableBody>
            {DEFAULT_PAGE_PERMISSIONS.map((page, index) => {
              const availablePermissions = getAvailablePermissions(page.name);

              return (
                <TableRow
                  key={index}
                  className='border-none transition-colors duration-300 even:bg-accent/50 hover:bg-accent'
                >
                  <TableCell className='py-3 font-medium'>
                    <div className='flex items-center justify-between'>
                      <div className='text-right'>
                        <div className='font-semibold'>
                          {DASHBOARD_PAGES[page.name]}
                        </div>
                      </div>
                      <button
                        onClick={() => toggleRowAll(index)}
                        type='button'
                        className='mr-2 rounded-md text-xs text-muted-foreground transition-all duration-300 hover:text-foreground'
                      >
                        اختيار الكل
                      </button>
                    </div>
                  </TableCell>
                  {permissionActions.map((action, colIndex) => (
                    <TableCell key={colIndex}>
                      {availablePermissions.includes(action) && (
                        <PermissionsTableCell
                          key={colIndex}
                          rowIndex={index}
                          colIndex={colIndex}
                        />
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </>
    );
  }
);

PermissionsTable.displayName = 'PermissionsTable';
export default PermissionsTable;
