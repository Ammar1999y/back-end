import type { Category } from '@/components/categories/types';
import type { CreateCategoryInput } from '@/utils/validation/categories';
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
import {
  CreateCategoryOutput,
  createCategorySchema,
} from '@/utils/validation/categories';

import { CategoryForm } from '@/components/categories/form';
import { CATEGORIES_QUERY_KEYS } from '@/components/categories/query-keys';
import { flattenErrors, showFormErrors } from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';

const NewCategory = () => {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<CreateCategoryInput>({
    resolver: zodResolver(createCategorySchema),
    disabled: loading,
    defaultValues: {
      title: '',
      isActive: true,
    },
  });

  const { handleSubmit } = methods;

  const onSubmit = useCallback(
    async (data: CreateCategoryInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});

      try {
        const validatedData = data as CreateCategoryOutput;
        const result = await mutate<
          Pick<Category, 'id' | 'createdAt'>,
          CreateCategoryOutput
        >({
          href: '/api/dash/projects/categories',
          method: 'POST',
          data: validatedData,
          onSuccess: (serverData) => {
            const newCategory: Category = {
              ...validatedData,
              id: serverData.id,
              createdAt: serverData.createdAt,
            };
            const existingList = queryClient.getQueryData<Category[]>(
              CATEGORIES_QUERY_KEYS.list
            );
            queryClient.setQueryData(
              CATEGORIES_QUERY_KEYS.detail(serverData.id!),
              newCategory
            );
            if (existingList)
              queryClient.setQueryData(CATEGORIES_QUERY_KEYS.list, [
                newCategory,
                ...existingList,
              ]);
          },
        });

        toast.success(result.message || 'تم إنشاء التصنيف بنجاح');
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
    [queryClient, router]
  );

  const onError = useCallback((errors: FieldErrors<CreateCategoryInput>) => {
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
          title='إضافة تصنيف جديد'
          loading={loading}
          cancelHref='/dash/projects/categories'
        />
        <CategoryForm />
      </form>
    </FormProvider>
  );
};

export default NewCategory;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/categories/new',
      title: {
        template: 'إضافة تصنيف',
      },
    },
  };
}
