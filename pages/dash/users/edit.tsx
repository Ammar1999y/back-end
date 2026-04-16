import type { User } from '@/components/users/types';
import type {
  UpdateUserInput,
  UpdateUserOutput,
} from '@/utils/validation/auth';
import type { FieldErrors } from 'react-hook-form';

import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { validID } from '@/utils';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import {
  CUSTOM_ROLE_VALUE,
  PERMISSION_ACTIONS,
  PermissionAction,
} from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

import { CustomError } from '@/utils/error-class';
import { mutate } from '@/utils/mutation';
import { useQueryData } from '@/utils/query';
import { useErrors } from '@/utils/store/errors';
import { updateUserSchema } from '@/utils/validation/auth';

import ErrorMessage from '@/components/error-message';
import {
  flattenErrors,
  showFormErrors,
} from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import LoadingPage from '@/components/loading-page';
import UserForm from '@/components/users/form/index';
import RolesTable from '@/components/users/form/roles-table';
import { usePermissionsTableStore } from '@/components/users/permissions-table/store';
import { USERS_QUERY_KEYS } from '@/components/users/query-keys';

const EditUser = () => {
  const [loading, setLoading] = useState(false);
  const initialDataRef = useRef<User | null>(null);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { id: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);

  const queryParams = useMemo(
    () => ({
      queryKey: USERS_QUERY_KEYS.detail(id),
      href: `/api/dash/users/${id}`,
      enabled: !!id,
      requiredData: id,
    }),
    [id]
  );

  const {
    data: userData,
    isLoading,
    error,
    refetch,
  } = useQueryData<User>(queryParams);

  const methods = useForm<UpdateUserInput>({
    resolver: zodResolver(updateUserSchema),
    disabled: loading,
  });

  const { handleSubmit, reset, control } = methods;
  const watchedId = useWatch({
    control,
    name: 'id',
  });
  const isFormHydrated = useMemo(() => !!validID(watchedId), [watchedId]);

  // Reset form when user data is loaded
  useEffect(() => {
    if (userData) {
      reset({
        ...userData,
        roleId: userData.roleId || '',
      });
      initialDataRef.current = userData;

      // Initialize permissions table store for custom role users
      if (
        userData.roleId === CUSTOM_ROLE_VALUE &&
        userData.permissions?.length
      ) {
        const ACTIONS_ARRAY = Object.keys(
          PERMISSION_ACTIONS
        ) as PermissionAction[];
        usePermissionsTableStore.getState().initializeStates(
          userData.permissions.map((p) => ({
            name: p.name,
            permissions: Object.fromEntries(
              ACTIONS_ARRAY.map((action) => [
                action,
                Boolean(p.permissions[action]),
              ])
            ),
          }))
        );
      }
    }
  }, [userData, reset]);

  const onSubmit = useCallback(
    async (data: UpdateUserInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});

      try {
        // After validation, data is guaranteed to match UpdateUserOutput
        const validatedData = data as UpdateUserOutput;

        const payload: Partial<UpdateUserOutput> = {
          id: validatedData.id,
          name: validatedData.name,
          email: validatedData.email,
          isActive: validatedData.isActive,
          roleId: validatedData.roleId,
          password: validatedData.password,
        };

        // Only include permissions if:
        // 1. Role is custom AND permissions exist AND
        // 2. Either role changed to/from custom OR permissions actually changed
        if (
          validatedData.roleId === CUSTOM_ROLE_VALUE &&
          validatedData.permissions
        ) {
          const initialRoleId = initialDataRef.current?.roleId;
          const initialPermissions = initialDataRef.current?.permissions;

          const roleChanged = initialRoleId !== validatedData.roleId;
          const permissionsChanged =
            JSON.stringify(initialPermissions) !==
            JSON.stringify(validatedData.permissions);

          if (roleChanged || permissionsChanged) {
            payload.permissions = validatedData.permissions;
          }
        }

        const result = await mutate<
          Pick<User, 'updatedAt'>,
          Partial<UpdateUserOutput>
        >({
          href: `/api/dash/users/${validatedData.id}`,
          method: 'PUT',
          data: payload,
          onSuccess: (serverData) => {
            const { password: _, ...data } = validatedData;

            const updatedUser: User = {
              ...data,
              role: userData?.role || null,
              updatedAt: serverData.updatedAt || new Date().toISOString(),
              createdAt: userData?.createdAt || new Date().toISOString(),
            };

            // Update detail cache
            queryClient.setQueryData(
              USERS_QUERY_KEYS.detail(validatedData.id),
              updatedUser
            );

            // Update list cache
            const existingList = queryClient.getQueryData<User[]>(
              USERS_QUERY_KEYS.list
            );
            if (existingList) {
              queryClient.setQueryData(
                USERS_QUERY_KEYS.list,
                existingList.map((item) =>
                  item.id === validatedData.id ? updatedUser : item
                )
              );
            }
          },
        });

        toast.success(result.message || 'تم تحديث المستخدم بنجاح');
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
    [userData, queryClient, router]
  );

  const onError = useCallback((errors: FieldErrors<UpdateUserInput>) => {
    const erros = flattenErrors(errors);
    showFormErrors(erros);
    useErrors.getState().setErrors(erros);
  }, []);

  useEffect(() => {
    return () => useErrors.getState().setErrors({});
  }, []);

  return isLoading || !isFormHydrated ? (
    <LoadingPage />
  ) : userData?.id ? (
    <FormProvider {...methods}>
      <form
        className={cn('transition-[max-width,opacity]', loading && 'disabled')}
        inert={loading}
        onSubmit={handleSubmit(onSubmit, onError)}
      >
        <Header
          title='تعديل المستخدم'
          loading={loading}
          cancelHref='/dash/users'
        />
        <UserForm isEdit />
        <RolesTable setInitPermissions={false} />
      </form>
    </FormProvider>
  ) : (
    <ErrorMessage error={error || null} refetch={refetch} />
  );
};

export default EditUser;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/users/edit',
      title: {
        template: 'تعديل المستخدم',
      },
    },
  };
}
