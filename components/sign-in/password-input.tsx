import { memo, useCallback, useState } from 'react';

import { Eye as _Eye, EyeClosed as _EyeClosed } from 'lucide-react';
import { useFormContext } from 'react-hook-form';

import { LoginFormData } from '@/utils/validation/auth';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const Eye = memo(_Eye);
Eye.displayName = 'Eye';

const EyeClosed = memo(_EyeClosed);
EyeClosed.displayName = 'EyeClosed';

const PasswordInput = memo(() => {
  const { register } = useFormContext<LoginFormData>();
  const [showPassword, setShowPassword] = useState(false);

  const toggleShowPassword = useCallback(() => {
    setShowPassword((prev) => !prev);
  }, []);

  const name = register('password').name;

  return (
    <div className='relative'>
      <Input
        {...register('password')}
        dir='ltr'
        id={name}
        type={showPassword ? 'text' : 'password'}
        autoComplete='password'
        className='pe-14'
        placeholder=''
      />
      <Button
        className='absolute right-3 top-1/2 -translate-y-1/2 py-1 text-gray-500'
        variant='none'
        aria-label={showPassword ? 'اخفاء كلمة المرور' : 'اظهار كلمة المرور'}
        size='icon'
        onClick={toggleShowPassword}
      >
        {showPassword ? <EyeClosed /> : <Eye />}
      </Button>
    </div>
  );
});

PasswordInput.displayName = 'PasswordInput';

export default PasswordInput;
