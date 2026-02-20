import type { Category } from '@/components/categories/types';
import type {
  UpdateCategoryInput,
  UpdateCategoryOutput,
} from '@/utils/validation/categories';
import type { FieldErrors } from 'react-hook-form';

import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { validID } from '@/utils';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

import { CustomError } from '@/utils/error-class';
import { mutate } from '@/utils/mutation';
import { useQueryData } from '@/utils/query';
import { useErrors } from '@/utils/store/errors';
import { updateCategorySchema } from '@/utils/validation/categories';

import { CategoryForm } from '@/components/categories/form';
import { CATEGORIES_QUERY_KEYS } from '@/components/categories/query-keys';
import ErrorMessage from '@/components/error-message';
import { flattenErrors } from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import LoadingPage from '@/components/loading-page';

const EditCategory = () => {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { categoryId: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);

  const queryParams = useMemo(
    () => ({
      queryKey: CATEGORIES_QUERY_KEYS.detail(id),
      href: `/api/dash/projects/categories/${id}`,
      enabled: !!id,
      requiredData: id,
    }),
    [id]
  );

  const {
    data: categoryData,
    isLoading,
    error,
    refetch,
  } = useQueryData<Category>(queryParams);

  const methods = useForm<UpdateCategoryInput>({
    resolver: zodResolver(updateCategorySchema),
    disabled: loading,
    defaultValues: {
      title: '',
      isActive: true,
    },
  });

  const { handleSubmit, reset, control } = methods;
  const watchedId = useWatch({
    control,
    name: 'id',
  });
  const isFormHydrated = useMemo(() => !!validID(watchedId), [watchedId]);

  // Reset form when data is loaded
  useEffect(() => {
    if (categoryData) {
      reset(categoryData);
    }
  }, [categoryData, reset]);

  const onSubmit = useCallback(
    async (data: UpdateCategoryInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});

      try {
        // After validation, data is guaranteed to match UpdateCategoryOutput
        const validatedData = data as UpdateCategoryOutput;
        const result = await mutate<
          Pick<Category, 'updatedAt'>,
          UpdateCategoryOutput
        >({
          href: `/api/dash/projects/categories/${validatedData.id}`,
          method: 'PUT',
          data: validatedData,
          onSuccess: (serverData) => {
            const updatedCategory: Category = {
              ...validatedData,
              updatedAt: serverData.updatedAt || new Date().toISOString(),
              createdAt: categoryData?.createdAt || new Date().toISOString(),
            };

            // Update detail cache
            queryClient.setQueryData(
              CATEGORIES_QUERY_KEYS.detail(validatedData.id),
              updatedCategory
            );

            // Update list cache
            const existingList = queryClient.getQueryData<Category[]>(
              CATEGORIES_QUERY_KEYS.list
            );
            if (existingList)
              queryClient.setQueryData(
                CATEGORIES_QUERY_KEYS.list,
                existingList.map((item) =>
                  item.id === validatedData.id ? updatedCategory : item
                )
              );
          },
        });

        toast.success(result.message || 'تم تحديث التصنيف بنجاح');
        router.push('/dash/projects/categories');
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
    [categoryData, queryClient, router]
  );

  const onError = useCallback((errors: FieldErrors<UpdateCategoryInput>) => {
    useErrors.getState().setErrors(flattenErrors(errors));
  }, []);

  useEffect(() => {
    return () => useErrors.getState().setErrors({});
  }, []);

  return isLoading || !isFormHydrated ? (
    <LoadingPage />
  ) : categoryData?.id ? (
    <FormProvider {...methods}>
      <form
        className={cn('transition-[max-width,opacity]', loading && 'disabled')}
        inert={loading}
        onSubmit={handleSubmit(onSubmit, onError)}
      >
        <Header
          title='تعديل التصنيف'
          loading={loading}
          cancelHref='/dash/projects/categories'
        />
        <CategoryForm />
      </form>
    </FormProvider>
  ) : (
    <ErrorMessage error={error || null} refetch={refetch} />
  );
};

export default EditCategory;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/categories/edit',
      title: {
        template: 'تعديل التصنيف',
      },
    },
  };
}
