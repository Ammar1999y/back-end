import type { LoginFormData } from '@/utils/validation/auth';
import type { FieldErrors } from 'react-hook-form';

import { useCallback, useEffect, useRef, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { FormProvider, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { authClient } from '@/lib/auth/client';
import { fastestFetchWithin } from '@/lib/race-fetch';
import { cn } from '@/lib/utils';

import { CustomError } from '@/utils/error-class';
import { useErrors } from '@/utils/store/errors';
import { loginSchema } from '@/utils/validation/auth';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import { ErrorMessage } from '@/components/form/error-message';
import {
  flattenErrors,
  showFormErrors,
} from '@/components/form/form-error-handeling';
import PasswordInput from '@/components/sign-in/password-input';

import TurnstileWidget from './turnstile';

interface FormProps {
  onSuccess: () => void;
}

const Form = ({ onSuccess }: FormProps) => {
  const [loading, setLoading] = useState(false);
  const [resetTurnstile, setResetTurnstile] = useState(false);
  const userIp = useRef<string | null>(null);
  const methods = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    disabled: loading,
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const { handleSubmit, register, setValue } = methods;

  const onSubmit = useCallback(
    async (data: LoginFormData) => {
      setLoading(true);
      useErrors.getState().setErrors({});
      if (!userIp.current) {
        const res = await fastestFetchWithin(
          ['https://api.ipify.org?format=json', 'https://ipinfo.io/json'],
          3000
        );
        userIp.current = res ? (await res.json())?.ip : null;
      }
      try {
        const { data: resData, error } = await authClient.signIn.email({
          email: data.email,
          password: data.password,
          fetchOptions: {
            headers: {
              'x-captcha-response': data.captcha + 'hgvcxcv',
              ...(userIp.current && {
                'x-captcha-user-remote-ip': userIp.current,
              }),
            },
          },
        });
        if (error) throw error;
        if (!resData?.user?.id) throw new CustomError('حدث خطاء، اعد المحاوله');
        toast.success('تم تسجيل الدخول بنجاح');
        onSuccess();
      } catch (error: any) {
        setValue('captcha', '');
        setResetTurnstile(true);
        toast.error(
          error instanceof CustomError
            ? error.message
            : error?.message?.toLowerCase?.()?.includes('captcha')
              ? 'حدث خطاء اثناء التحقق من انك انسان، اعد المحاولة'
              : 'حدث خطاء، اعد المحاوله',
          {
            duration: 8000,
          }
        );
      }
      setLoading(false);
    },
    [onSuccess, setValue]
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
        <TurnstileWidget reset={resetTurnstile} setReset={setResetTurnstile} />

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
