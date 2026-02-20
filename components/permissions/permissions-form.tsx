import type { PagePermission } from '@/components/users/permissions-table/types';

import { memo, useCallback } from 'react';

import { useFormContext } from 'react-hook-form';

import {
  CreatePermissionFormData,
  UpdatePermissionFormData,
} from '@/utils/validation/permissions';

import { AutosizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Input } from '@/components/ui/input';
import UserStatusSwitch from '@/components/ui/switch-larg';
import { ErrorMessage } from '@/components/form/error-message';
import PermissionsTable from '@/components/users/permissions-table/permissions-table';

import Label from '../ui/label';

const PermissionsForm = memo(
  ({ setInitPermissions = true }: { setInitPermissions?: boolean }) => {
    const { register, setValue } = useFormContext<
      CreatePermissionFormData | UpdatePermissionFormData
    >();
    const handlePermissionsChange = useCallback(
      (permissions: PagePermission[]) => {
        setValue('permissions', permissions);
      },
      [setValue]
    );

    return (
      <div className='formContentPadding space-y-6'>
        <div className='grid gap-x-4 gap-y-5 xs2:grid-cols-12 md:gap-6'>
          <div className='order-1 xs2:col-span-8 sm:col-span-4'>
            <Label
              title={`الاسم`}
              require
              htmlFor={register('roleName').name}
            />
            <Input
              id={register('roleName').name}
              {...register('roleName')}
              placeholder=''
            />
            <ErrorMessage path={register('roleName').name} />
          </div>

          <div className='order-3 xs2:col-span-12 sm:order-2 sm:col-span-5'>
            <Label title={`الوصف`} htmlFor={register('description').name} />
            <AutosizeTextarea
              id={register('description').name}
              placeholder=''
              rows={1}
              minRows={3}
              className='px-3 pb-2 pt-3'
              {...register('description')}
            />
            <ErrorMessage path={register('description').name} />
          </div>
          <div className='order-2 flex items-center gap-2 xs2:col-span-4 xs2:flex-col xs2:items-start sm:order-3 sm:col-span-3'>
            <Label
              title={`الحالة`}
              htmlFor={register('isActive').name}
              className='mb-0'
            />
            <UserStatusSwitch
              name={register('isActive').name}
              ariaLabel='تبديل حالة الدور'
            />
          </div>
        </div>

        <div>
          <h2 className='mb-4 text-lg font-semibold'>الصلاحيات</h2>
          <PermissionsTable
            onPermissionsChange={handlePermissionsChange}
            setInitPermissions={setInitPermissions}
          />
          <ErrorMessage path='permissions' />
        </div>
      </div>
    );
  }
);

PermissionsForm.displayName = 'PermissionsForm';

export default PermissionsForm;
