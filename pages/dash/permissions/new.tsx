import type { Permission } from '@/components/permissions/types';
import type { CreatePermissionInput } from '@/utils/validation/permissions';
import type { FieldErrors } from 'react-hook-form';

import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

import { CustomError } from '@/utils/error-class';
import { mutate } from '@/utils/mutation';
import { useErrors } from '@/utils/store/errors';
import {
  CreatePermissionOutput,
  createPermissionSchema,
} from '@/utils/validation/permissions';

import {
  flattenErrors,
  showFormErrors,
} from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import PermissionsForm from '@/components/permissions/permissions-form';
import { PERMISSIONS_QUERY_KEYS } from '@/components/permissions/query-keys';
import { RoleOption } from '@/components/users/form/role';
import { ROLES_QUERY_KEYS } from '@/components/users/query-keys';

const NewPermission = () => {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<CreatePermissionInput>({
    resolver: zodResolver(createPermissionSchema),
    disabled: loading,
    defaultValues: {
      roleName: '',
      permissions: [],

      isActive: true,
    },
  });

  const { handleSubmit } = methods;

  const onSubmit = useCallback(
    async (data: CreatePermissionInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});

      try {
        // After validation, data is guaranteed to match CreatePermissionOutput
        const validatedData = data as CreatePermissionOutput;
        const result = await mutate<
          Pick<Permission, 'id' | 'createdAt'>,
          CreatePermissionOutput
        >({
          href: '/api/dash/permissions',
          method: 'POST',
          data: validatedData,
          onSuccess: (serverData) => {
            // The roles cache below is a plain array under its own key and is
            // still patched. The permissions LIST is not: it is keyed by
            // page/sort/filters/search with a `{ data, meta }` value, so
            // prepending to `getQueryData(list)` never reached the table.
            queryClient.invalidateQueries({
              queryKey: PERMISSIONS_QUERY_KEYS.list,
            });

            // Update roles cache if role is active
            if (validatedData.isActive) {
              const existingRoles = queryClient.getQueryData<RoleOption[]>(
                ROLES_QUERY_KEYS.list
              );

              if (existingRoles) {
                const newRole: RoleOption = {
                  id: serverData.id,
                  roleName: validatedData.roleName,
                };

                queryClient.setQueryData(ROLES_QUERY_KEYS.list, [
                  newRole,
                  ...existingRoles.filter((r) => r.id !== CUSTOM_ROLE_VALUE),
                  { id: CUSTOM_ROLE_VALUE, roleName: 'مخصص' },
                ]);
              }
            }
          },
        });

        toast.success(result.message || 'تم إنشاء الصلاحية بنجاح');
        router.push('/dash/permissions');
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

  const onError = useCallback((errors: FieldErrors<CreatePermissionInput>) => {
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
          title='إنشاء صلاحية جديدة'
          loading={loading}
          cancelHref='/dash/permissions'
        />
        <PermissionsForm />
      </form>
    </FormProvider>
  );
};

export default NewPermission;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/permissions/new',
      title: {
        template: 'إنشاء صلاحية',
      },
    },
  };
}
