import type { Section } from '@/components/sections/types';
import type { CreateSectionInput } from '@/utils/validation/sections';
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
  CreateSectionOutput,
  createSectionSchema,
} from '@/utils/validation/sections';

import {
  flattenErrors,
  showFormErrors,
} from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import { MainTabs } from '@/components/form/tabs/main-tabs';
import { useTabsStore } from '@/components/form/tabs/store';
import { FormContent, MAIN_TABS } from '@/components/sections/form/sections';
import { SECTIONS_QUERY_KEYS } from '@/components/sections/query-keys';
import { SmoothHeightContainer } from '@/components/smooth-height-container';

const NewSection = () => {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<CreateSectionInput>({
    resolver: zodResolver(createSectionSchema),
    disabled: loading,
    defaultValues: {
      title: '',
      subtitle: '',

      isActive: true,
    },
  });

  const { handleSubmit } = methods;

  const onSubmit = useCallback(
    async (data: CreateSectionInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});
      // After validation, data is guaranteed to match CreateSectionOutput
      const validatedData = data as CreateSectionOutput;

      try {
        const result = await mutate<
          Pick<Section, 'id' | 'createdAt'>,
          CreateSectionOutput
        >({
          href: '/api/dash/sections',
          method: 'POST',
          data: validatedData,
          onSuccess: (serverData) => {
            const newSection: Section = {
              ...validatedData,
              id: serverData.id,
              createdAt: serverData.createdAt,
            };
            const existingSections = queryClient.getQueryData<Section[]>(
              SECTIONS_QUERY_KEYS.list
            );
            queryClient.setQueryData(
              SECTIONS_QUERY_KEYS.detail(serverData.id),
              newSection
            );
            if (existingSections)
              queryClient.setQueryData(SECTIONS_QUERY_KEYS.list, [
                newSection,
                ...existingSections,
              ]);
          },
        });

        toast.success(result.message || 'تم إنشاء القسم بنجاح');
        router.push('/dash/sections');
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

  const onError = useCallback((errors: FieldErrors<CreateSectionInput>) => {
    const erros = flattenErrors(errors);
    showFormErrors(erros);
    useErrors.getState().setErrors(erros);
  }, []);

  useEffect(() => {
    return () => {
      useErrors.getState().setErrors({});
      useTabsStore.getState().reset();
    };
  }, []);

  return (
    <FormProvider {...methods}>
      <form
        onSubmit={handleSubmit(onSubmit, onError)}
        className={cn('transition-[max-width,opacity]', loading && 'disabled')}
        inert={loading}
      >
        <Header
          title='إضافة قسم جديد'
          loading={loading}
          cancelHref='/dash/sections'
          containerClassName='border-b-0 mb-5'
        />

        <MainTabs tabs={MAIN_TABS} />

        <SmoothHeightContainer className='px-1 pb-10 pt-4'>
          <FormContent />
        </SmoothHeightContainer>
      </form>
    </FormProvider>
  );
};

export default NewSection;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/sections/new',
      title: {
        template: 'إضافة قسم',
      },
    },
  };
}
