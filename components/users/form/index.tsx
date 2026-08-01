import { memo } from 'react';

import { useFormContext } from 'react-hook-form';

import {
  CreateUserFormData,
  UpdateUserFormData,
} from '@/utils/validation/auth';
import { PHONE_ENABLED, PHONE_REQUIRED } from '@/utils/config';

import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import UserStatusSwitch from '@/components/ui/switch-larg';
import { ErrorMessage } from '@/components/form/error-message';
import PasswordInput from '@/components/users/form/password';
import PasswordStrength from '@/components/users/form/password-strength';
import RoleInput from '@/components/users/form/role';

interface UserFormProps {
  isEdit?: boolean;
}

const UserForm = memo(({ isEdit = false }: UserFormProps) => {
  const { register } = useFormContext<
    CreateUserFormData | UpdateUserFormData
  >();
  return (
    <div className='grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3'>
      <div>
        <Label title={`الاسم`} require htmlFor={register('name').name} />
        <Input
          autoFocus
          id={register('name').name}
          type={'text'}
          placeholder={''}
          dir='auto'
          autoComplete='off'
          {...register('name')}
        />
        <ErrorMessage path={register('name').name} />
      </div>
      <div>
        <Label
          title={`البريد الإلكتروني`}
          require
          htmlFor={register('email').name}
        />
        <Input
          id={register('email').name}
          type={'text'}
          dir='ltr'
          placeholder={''}
          autoComplete='off'
          {...register('email')}
        />
        <ErrorMessage path={register('email').name} />
      </div>
      <div>
        <Label
          title={isEdit ? 'تغير كلمة السر' : 'كلمة المرور'}
          require
          htmlFor={register('password').name}
        />
        <PasswordInput />
        <ErrorMessage path={register('password').name} />
        <PasswordStrength />
      </div>
      {PHONE_ENABLED && (
        <div>
          <Label
            title='رقم الهاتف'
            require={PHONE_REQUIRED}
            htmlFor={register('phoneNumber').name}
          />
          <Input
            id={register('phoneNumber').name}
            type='tel'
            dir='ltr'
            placeholder='05XXXXXXXX'
            autoComplete='off'
            {...register('phoneNumber')}
          />
          <ErrorMessage path={register('phoneNumber').name} />
        </div>
      )}
      <div>
        <RoleInput />
        <ErrorMessage path={register('roleId').name} />
      </div>
      <div className='mt-3 flex items-center gap-x-4 gap-y-3 lg:mt-0 lg:flex-col lg:items-start'>
        <Label
          title='الحالة'
          className='mb-0'
          htmlFor={register('isActive').name}
        />
        <UserStatusSwitch name='isActive' ariaLabel='تبديل حالة المستخدم' />
      </div>
    </div>
  );
});

UserForm.displayName = 'UserForm';

export default UserForm;
