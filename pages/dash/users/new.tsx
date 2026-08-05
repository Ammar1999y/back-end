import type { User } from '@/components/users/types';
import type { CreateUserInput } from '@/utils/validation/auth';
import type { FieldErrors } from 'react-hook-form';

import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

import { CustomError } from '@/utils/error-class';
import { mutate } from '@/utils/mutation';
import { useErrors } from '@/utils/store/errors';
import { CreateUserOutput, createUserSchema } from '@/utils/validation/auth';

import {
  flattenErrors,
  showFormErrors,
} from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import UserForm from '@/components/users/form/index';
import RolesTable from '@/components/users/form/roles-table';
import { USERS_QUERY_KEYS } from '@/components/users/query-keys';

const NewUser = () => {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    disabled: loading,
    defaultValues: {
      name: '',
      email: '',
      password: '',
      phoneNumber: '',
      isActive: true,
      roleId: undefined,
      permissions: undefined,
    },
  });

  const { handleSubmit } = methods;

  const onSubmit = useCallback(
    async (data: CreateUserInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});

      try {
        // After validation, data is guaranteed to match CreateUserOutput
        const validatedData = data as CreateUserOutput;
        const result = await mutate<
          Pick<User, 'id' | 'createdAt'>,
          CreateUserOutput
        >({
          href: '/api/dash/users',
          method: 'POST',
          data: validatedData,
          onSuccess: () => {
            // Server-authoritative refetch instead of prepending a locally
            // assembled row: the list is keyed by page/sort/filters/search
            // (value `{ data, meta }`), so the prepend never landed, and the
            // fabricated row carried `role: null` for a user who has one.
            queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEYS.list });
          },
        });

        toast.success(result.message || 'تم إنشاء المستخدم بنجاح');
        router.push('/dash/users');
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
    [queryClient, router]
  );

  const onError = useCallback((errors: FieldErrors<CreateUserInput>) => {
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
        className={cn('transition-[max-width,opacity]', loading && 'disabled')}
        inert={loading}
      >
        <Header
          title='إنشاء مستخدم جديد'
          loading={loading}
          cancelHref='/dash/users'
        />
        <div className='formContentPadding'>
          <UserForm />
          <RolesTable />
        </div>
      </form>
    </FormProvider>
  );
};

export default NewUser;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/users/new',
      title: {
        template: 'إنشاء مستخدم',
      },
    },
  };
}
