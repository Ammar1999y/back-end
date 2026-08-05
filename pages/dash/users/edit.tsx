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
import { useSession } from '@/lib/auth/use-session';
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

  const { data: session } = useSession();
  // Which server schema this PUT will be validated against.
  const isSelfEdit = !!id && session?.user?.id === id;

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
        roleId: userData.roleId || undefined,
        phoneNumber: userData.phoneNumber ?? '',
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

        // Editing your own row hits the self-edit branch of PUT /users/:id,
        // whose contract is `{ id, name }` and nothing else — it rejects
        // unknown keys. Sending the admin payload there was a guaranteed 422,
        // so the ordinary "edit my own profile" path never worked. The wire
        // payload has to match the schema the endpoint will actually pick.
        const payload: Partial<UpdateUserOutput> = isSelfEdit
          ? { id: validatedData.id, name: validatedData.name }
          : {
              id: validatedData.id,
              name: validatedData.name,
              email: validatedData.email,
              phoneNumber: validatedData.phoneNumber,
              isActive: validatedData.isActive,
              roleId: validatedData.roleId,
              password: validatedData.password,
            };

        // Only include permissions if:
        // 1. Not a self-edit (that contract carries name only) AND
        // 2. Role is custom AND permissions exist AND
        // 3. Either role changed to/from custom OR permissions actually changed
        if (
          !isSelfEdit &&
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
          onSuccess: () => {
            // Invalidate, don't patch. The list lives under EXPANDED keys
            // (`[...list, page, perPage, sort, filters, joinOperator, search]`)
            // holding `{ data, meta }`, so `getQueryData(list)` was always
            // undefined and the patch below it silently did nothing — the table
            // kept serving the pre-edit rows for the whole stale window. And
            // rebuilding the row from form state guessed at fields the server
            // owns (updatedAt, verified flags, the role after a custom edit).
            // `list` is a prefix of `detail`, so one call covers both.
            queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEYS.list });
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
    [isSelfEdit, queryClient, router]
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
