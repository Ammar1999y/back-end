import type { LoginFormData } from '@/utils/validation/auth';
import type { FieldErrors } from 'react-hook-form';

import { useCallback, useEffect, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { FormProvider, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

import { CustomError } from '@/utils/error-class';
import { useErrors } from '@/utils/store/errors';
import { loginSchema } from '@/utils/validation/auth';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import { ErrorMessage } from '@/components/form/error-message';
import { flattenErrors, showFormErrors } from '@/components/form/form-error-handeling';
import PasswordInput from '@/components/sign-in/password-input';

interface FormProps {
  onSuccess: () => void;
}

const Form = ({ onSuccess }: FormProps) => {
  const [loading, setLoading] = useState(false);

  const methods = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    disabled: loading,
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const { handleSubmit, register } = methods;

  const onSubmit = useCallback(
    async (data: LoginFormData) => {
      setLoading(true);
      useErrors.getState().setErrors({});

      try {
        console.log('Login data:', data);

        // Simulate API call
        await new Promise((resolve) => setTimeout(resolve, 1000));

        toast.success('تم تسجيل الدخول بنجاح');
        onSuccess();
      } catch (error) {
        toast.error(
          error instanceof CustomError
            ? error.message
            : 'حدث خطاء، اعد المحاوله'
        );
      } finally {
        setLoading(false);
      }
    },
    [onSuccess]
  );

  const onError = useCallback((errors: FieldErrors<LoginFormData>) => {
    const erros = flattenErrors(errors);
    showFormErrors(erros);
    useErrors.getState().setErrors(erros);
  }, []);

  useEffect(() => {
    return () => useErrors.getState().setErrors({});
  }, []);

  return (
    <FormProvider {...methods}>
      <form
        onSubmit={handleSubmit(onSubmit, onError)}
        className={cn(
          'mt-6 transition-opacity space-y-6',
          loading && 'disabled'
        )}
        inert={loading}
      >
        <div>
          <Label
            title='البريد الإلكتروني'
            require
            htmlFor={register('email').name}
          />
          <Input
            autoFocus
            id={register('email').name}
            type='text'
            dir='ltr'
            placeholder=''
            autoComplete='email'
            {...register('email')}
          />
          <ErrorMessage path={register('email').name} />
        </div>

        <div>
          <Label
            title='كلمة المرور'
            require
            htmlFor={register('password').name}
          />
          <PasswordInput />
          <ErrorMessage path={register('password').name} />
        </div>

        <Button
          type='submit'
          className='w-full'
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? 'جاري تسجيل الدخول...' : 'تسجيل الدخول'}
        </Button>
      </form>
    </FormProvider>
  );
};

export default Form;
