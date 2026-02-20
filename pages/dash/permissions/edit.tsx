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
import { updatePermissionSchema } from '@/utils/validation/permissions';

import ErrorMessage from '@/components/error-message';
import { flattenErrors } from '@/components/form/form-error-handeling';
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

      const ACTIONS_ARRAY = Object.keys(
        PERMISSION_ACTIONS
      ) as PermissionAction[];
      usePermissionsTableStore.setState({
        checkboxStates: permissionData.permissions.map((page) =>
          ACTIONS_ARRAY.map((action) => Boolean(page.permissions[action]))
        ),
      });
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
          onSuccess: (serverData) => {
            const updatedPermission: Permission = {
              ...validatedData,
              scope: 'standard',
              permissions:
                validatedData.permissions || permissionData?.permissions || [],
              updatedAt: serverData.updatedAt || new Date().toISOString(),
              createdAt: permissionData?.createdAt || new Date().toISOString(),
            };

            // Update detail cache
            queryClient.setQueryData(
              PERMISSIONS_QUERY_KEYS.detail(validatedData.id),
              updatedPermission
            );

            // Update list cache
            const existingList = queryClient.getQueryData<Permission[]>(
              PERMISSIONS_QUERY_KEYS.list
            );
            if (existingList) {
              queryClient.setQueryData(
                PERMISSIONS_QUERY_KEYS.list,
                existingList.map((item) =>
                  item.id === validatedData.id
                    ? { ...item, ...updatedPermission }
                    : item
                )
              );
            }

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
                  // Role became active: add to roles
                  const newRole: RoleOption = {
                    id: roleId,
                    value: roleId,
                    label: validatedData.roleName,
                  };
                  updatedRoles = [
                    newRole,
                    ...updatedRoles.filter((r) => r.value !== CUSTOM_ROLE_VALUE),
                    { value: CUSTOM_ROLE_VALUE, label: 'مخصص' } as RoleOption,
                  ];
                } else {
                  // Role became inactive: remove from roles
                  updatedRoles = updatedRoles.filter((r) => r.id !== roleId);
                }
              } else if (roleNameChanged && validatedData.isActive) {
                updatedRoles = updatedRoles.map((r) =>
                  r.id === roleId
                    ? {
                        ...r,
                        label: validatedData.roleName,
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
    useErrors.getState().setErrors(flattenErrors(errors));
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
