import type { Section } from '@/components/sections/types';
import type {
  UpdateSectionInput,
  UpdateSectionOutput,
} from '@/utils/validation/sections';
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
import { updateSectionSchema } from '@/utils/validation/sections';

import ErrorMessage from '@/components/error-message';
import { flattenErrors } from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import { MainTabs } from '@/components/form/tabs/main-tabs';
import { useTabsStore } from '@/components/form/tabs/store';
import LoadingPage from '@/components/loading-page';
import { FormContent, MAIN_TABS } from '@/components/sections/form/sections';
import { SECTIONS_QUERY_KEYS } from '@/components/sections/query-keys';
import { SmoothHeightContainer } from '@/components/smooth-height-container';

const EditSection = () => {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { sectionId: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);

  const queryParams = useMemo(
    () => ({
      queryKey: SECTIONS_QUERY_KEYS.detail(id),
      href: `/api/dash/sections/${id}`,
      enabled: !!id,
      requiredData: id,
    }),
    [id]
  );

  const {
    data: sectionData,
    isLoading,
    error,
    refetch,
  } = useQueryData<Section>(queryParams);

  const methods = useForm<UpdateSectionInput>({
    resolver: zodResolver(updateSectionSchema),
    disabled: loading,
    defaultValues: {
      id: undefined,
      title: '',
      subtitle: '',
      shortDescription: '',

      isActive: true,
    },
  });

  const { handleSubmit, reset, control } = methods;

  const watchedId = useWatch({
    control,
    name: 'id',
  });
  const isFormHydrated = useMemo(() => !!validID(watchedId), [watchedId]);

  // Reset form when section data is loaded
  useEffect(() => {
    if (sectionData) {
      reset(sectionData);
    }
  }, [sectionData, reset]);

  const onSubmit = useCallback(
    async (data: UpdateSectionInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});

      // After validation, data is guaranteed to match UpdateSectionOutput
      const validatedData = data as UpdateSectionOutput;
      try {
        const result = await mutate<
          Pick<Section, 'updatedAt'>,
          UpdateSectionOutput
        >({
          href: `/api/dash/sections/${validatedData.id}`,
          method: 'PUT',
          data: validatedData,
          onSuccess: (serverData) => {
            const updatedSection: Section = {
              ...validatedData,
              updatedAt: serverData.updatedAt || new Date().toISOString(),
              createdAt: sectionData?.createdAt || new Date().toISOString(),
              slug: sectionData?.slug, // Preserve slug as it's not editable
            };

            // Update detail cache
            queryClient.setQueryData(
              SECTIONS_QUERY_KEYS.detail(validatedData.id),
              updatedSection
            );

            // Update list cache
            const existingList = queryClient.getQueryData<Section[]>(
              SECTIONS_QUERY_KEYS.list
            );
            if (existingList)
              queryClient.setQueryData(
                SECTIONS_QUERY_KEYS.list,
                existingList.map((item) =>
                  item.id === validatedData.id ? updatedSection : item
                )
              );
          },
        });

        toast.success(result.message || 'تم تحديث القسم بنجاح');
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
    [sectionData, queryClient, router]
  );

  const onError = useCallback((errors: FieldErrors<UpdateSectionInput>) => {
    const erros = flattenErrors(errors);
    toast.error(
      (Object.values(erros)[0] as string) || 'تحقق من صحه جميع الخانات'
    );
    useErrors.getState().setErrors(erros);
  }, []);

  useEffect(() => {
    return () => {
      useErrors.getState().setErrors({});
      useTabsStore.getState().reset();
    };
  }, []);

  return isLoading || !isFormHydrated ? (
    <LoadingPage />
  ) : sectionData?.id ? (
    <FormProvider {...methods}>
      <form
        className={cn('transition-[max-width,opacity]', loading && 'disabled')}
        inert={loading}
        onSubmit={handleSubmit(onSubmit, onError)}
      >
        <Header
          title='تعديل بيانات القسم'
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
  ) : (
    <ErrorMessage error={error || null} refetch={refetch} />
  );
};

export default EditSection;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/sections/edit',
      title: {
        template: 'تعديل قسم',
      },
    },
  };
}
