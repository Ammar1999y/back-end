import type { PagePermission } from '@/components/users/permissions-table';

import { memo, useCallback } from 'react';

import { useFormContext, useWatch } from 'react-hook-form';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';

import PermissionsTable from '@/components/users/permissions-table';

const RolesTable = memo(
  ({ setInitPermissions = true }: { setInitPermissions?: boolean }) => {
    const { setValue } = useFormContext();
    const roleId = useWatch({
      name: 'roleId',
    });

    const handlePermissionsChange = useCallback(
      (permissions: PagePermission[]) => {
        setValue('permissions', permissions);
      },
      [setValue]
    );

    if (roleId !== CUSTOM_ROLE_VALUE) return null;

    return (
      <div className='mt-10'>
        <h2 className='mb-4 text-lg font-bold'>الصلاحيات</h2>
        <PermissionsTable
          onPermissionsChange={handlePermissionsChange}
          setInitPermissions={setInitPermissions}
        />
      </div>
    );
  }
);

RolesTable.displayName = 'RolesTable';

export default RolesTable;
