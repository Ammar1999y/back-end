import type { Permission } from '@/components/permissions/types';
import type {
  UpdatePermissionInput,
  UpdatePermissionOutput,
} from '@/utils/validation/permissions';
import type { FieldErrors } from 'react-hook-form';

import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { validID } from '@/utils';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { CUSTOM_ROLE_VALUE } from '@/lib/permissions/constants';
import { cn } from '@/lib/utils';

import { CustomError } from '@/utils/error-class';
import { mutate } from '@/utils/mutation';
import { useQueryData } from '@/utils/query';
import { useErrors } from '@/utils/store/errors';
import { updatePermissionSchema } from '@/utils/validation/permissions';

import ErrorMessage from '@/components/error-message';
import {
  flattenErrors,
  showFormErrors,
} from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import LoadingPage from '@/components/loading-page';
import PermissionsForm from '@/components/permissions/permissions-form';
import { PERMISSIONS_QUERY_KEYS } from '@/components/permissions/query-keys';
import { RoleOption } from '@/components/users/form/role';
import { usePermissionsTableStore } from '@/components/users/permissions-table/store';
import {
  ROLES_QUERY_KEYS,
  USERS_QUERY_KEYS,
} from '@/components/users/query-keys';

const EditPermission = () => {
  const [loading, setLoading] = useState(false);
  const initialDataRef = useRef<Permission | null>(null);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { id: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);

  const queryParams = useMemo(
    () => ({
      queryKey: PERMISSIONS_QUERY_KEYS.detail(id),
      href: `/api/dash/permissions/${id}`,
      enabled: !!id,
      requiredData: id,
    }),
    [id]
  );

  const {
    data: permissionData,
    isLoading,
    error,
    refetch,
  } = useQueryData<Permission>(queryParams);

  const methods = useForm<UpdatePermissionInput>({
    resolver: zodResolver(updatePermissionSchema),
    disabled: loading,
  });

  const { handleSubmit, reset, control } = methods;
  const watchedId = useWatch({
    control,
    name: 'id',
  });
  const isFormHydrated = useMemo(() => !!validID(watchedId), [watchedId]);

  // Reset form when permission data is loaded
  useEffect(() => {
    if (permissionData) {
      reset(permissionData);
      initialDataRef.current = permissionData;

      usePermissionsTableStore
        .getState()
        .initializeStates(permissionData.permissions);
    }
  }, [permissionData, reset]);

  const onSubmit = useCallback(
    async (data: UpdatePermissionInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});

      try {
        // After validation, data is guaranteed to match UpdatePermissionOutput
        const validatedData = data as UpdatePermissionOutput;

        const initialPermissions = initialDataRef.current?.permissions;
        const permissionsChanged =
          JSON.stringify(initialPermissions) !==
          JSON.stringify(validatedData.permissions);

        const payload: Partial<UpdatePermissionOutput> = {
          id: validatedData.id,
          roleName: validatedData.roleName,
          description: validatedData.description,
          isActive: validatedData.isActive,
        };

        if (permissionsChanged) payload.permissions = validatedData.permissions;

        const result = await mutate<
          Pick<Permission, 'updatedAt'>,
          Partial<UpdatePermissionOutput>
        >({
          href: `/api/dash/permissions/${validatedData.id}`,
          method: 'PUT',
          data: payload,
          onSuccess: () => {
            // Invalidate rather than patch: the list is keyed by
            // page/sort/filters/search with a `{ data, meta }` value, so the
            // old `getQueryData(list)` patch never landed, and rebuilding the
            // row from form state guessed `updatedAt`/`usersCount`. `list` is a
            // prefix of `detail`, so this covers both.
            queryClient.invalidateQueries({
              queryKey: PERMISSIONS_QUERY_KEYS.list,
            });

            // Handle roles cache updates
            const existingRoles = queryClient.getQueryData<RoleOption[]>(
              ROLES_QUERY_KEYS.list
            );
            const initialData = initialDataRef.current;
            const roleNameChanged =
              initialData?.roleName !== validatedData.roleName;

            if (roleNameChanged) {
              queryClient.invalidateQueries({
                queryKey: USERS_QUERY_KEYS.detailBase,
              });
            }

            if (existingRoles && initialData) {
              const isActiveChanged =
                initialData.isActive !== validatedData.isActive;

              let updatedRoles = [...existingRoles];
              const roleId = validID(validatedData.id);

              if (isActiveChanged) {
                if (validatedData.isActive) {
                  const newRole: RoleOption = {
                    id: roleId,
                    roleName: validatedData.roleName,
                  };
                  updatedRoles = [
                    newRole,
                    ...updatedRoles.filter((r) => r.id !== CUSTOM_ROLE_VALUE),
                    {
                      id: CUSTOM_ROLE_VALUE,
                      roleName: 'مخصص',
                    } as unknown as RoleOption,
                  ];
                } else {
                  updatedRoles = updatedRoles.filter((r) => r.id !== roleId);
                }
              } else if (roleNameChanged && validatedData.isActive) {
                updatedRoles = updatedRoles.map((r) =>
                  r.id === roleId
                    ? {
                        ...r,
                        roleName: validatedData.roleName,
                      }
                    : r
                );
              }

              queryClient.setQueryData(ROLES_QUERY_KEYS.list, updatedRoles);
            }
          },
        });

        toast.success(result.message || 'تم تحديث الصلاحية بنجاح');
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
    [permissionData, queryClient, router]
  );

  const onError = useCallback((errors: FieldErrors<UpdatePermissionInput>) => {
    const erros = flattenErrors(errors);
    showFormErrors(erros);
    useErrors.getState().setErrors(erros);
  }, []);

  useEffect(() => {
    return () => useErrors.getState().setErrors({});
  }, []);

  return isLoading || !isFormHydrated ? (
    <LoadingPage />
  ) : permissionData?.id ? (
    <FormProvider {...methods}>
      <form
        className={cn('transition-[max-width,opacity]', loading && 'disabled')}
        inert={loading}
        onSubmit={handleSubmit(onSubmit, onError)}
      >
        <Header
          title='تعديل الصلاحية'
          loading={loading}
          cancelHref='/dash/permissions'
        />
        <PermissionsForm setInitPermissions={false} />
      </form>
    </FormProvider>
  ) : (
    <ErrorMessage error={error || null} refetch={refetch} />
  );
};

export default EditPermission;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/permissions/edit',
      title: {
        template: 'تعديل الصلاحية',
      },
    },
  };
}
