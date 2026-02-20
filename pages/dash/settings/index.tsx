import type { Settings } from '@/components/settings/types';
import type {
  SettingsInput,
  SettingsOutput,
} from '@/utils/validation/settings';
import type { FieldErrors } from 'react-hook-form';

import { useCallback, useEffect, useMemo } from 'react';

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
import { settingsSchema } from '@/utils/validation/settings';

import { flattenErrors } from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import { MainTabs } from '@/components/form/tabs/main-tabs';
import { useTabsStore } from '@/components/form/tabs/store';
import LoadingPage from '@/components/loading-page';
import { FormContent, MAIN_TABS } from '@/components/settings/form/sections';
import { SETTINGS_QUERY_KEYS } from '@/components/settings/query-keys';
import { SmoothHeightContainer } from '@/components/smooth-height-container';

const formatDate = (dateString: string | null | undefined) => {
  if (!dateString) return null;
  try {
    return new Intl.DateTimeFormat('ar-SA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(dateString));
  } catch {
    return null;
  }
};

const DEFAULT_FONTS = {
  googleFont: null,
  letterSpacing: 0,
  lineHeight: 1,
  fontSizeMultiplier: 1,
};

const SettingsPage = () => {
  const queryClient = useQueryClient();

  const {
    data: settings,
    isLoading,
    isFetched,
  } = useQueryData<Settings | null>({
    queryKey: SETTINGS_QUERY_KEYS.settings,
    href: '/api/dash/settings',
  });

  const methods = useForm<SettingsInput>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      siteTitle: '',
      siteDescription: '',
      footerDescription: '',
      copyrightText: '',
      primaryColor: '',
      fonts: DEFAULT_FONTS,
      socialAccounts: [],
      contactInfo: [],
      navLinks: [],
    },
  });

  const {
    handleSubmit,
    reset,
    control,
    formState: { isSubmitting },
  } = methods;

  // Watch id to check if form is hydrated (for existing settings)
  const watchedId = useWatch({
    control,
    name: 'id',
  });

  // Form is hydrated when:
  // - No existing settings (new settings case) - isFetched is true and settings is null
  // - Existing settings loaded and form reset with id
  const isFormHydrated = useMemo(() => {
    if (!isFetched) return false;
    if (!settings) return true; // No existing settings, form can be used with defaults
    return !!validID(watchedId); // Has settings, wait for form to be reset with id
  }, [isFetched, settings, watchedId]);

  const lastUpdated = useMemo(() => {
    return formatDate(settings?.updatedAt);
  }, [settings?.updatedAt]);

  // Reset form when settings are loaded
  useEffect(() => {
    if (settings) {
      reset({
        id: settings.id,
        siteTitle: settings.siteTitle || '',
        siteDescription: settings.siteDescription || '',
        footerDescription: settings.footerDescription || '',
        copyrightText: settings.copyrightText || '',
        primaryColor: settings.primaryColor || '',
        fonts: settings.fonts || DEFAULT_FONTS,
        socialAccounts: settings.socialAccounts || [],
        contactInfo: settings.contactInfo || [],
        navLinks: settings.navLinks || [],
      });
    }
  }, [settings, reset]);

  const onSubmit = useCallback(
    async (data: SettingsInput) => {
      useErrors.getState().setErrors({});

      // After validation, data is guaranteed to match SettingsOutput
      const validatedData = data as SettingsOutput;

      try {
        const result = await mutate<
          Pick<Settings, 'id' | 'createdAt' | 'updatedAt'>,
          SettingsOutput
        >({
          href: '/api/dash/settings',
          method: 'POST',
          data: validatedData,
          onSuccess: (serverData) => {
            const newSettings: Settings = {
              ...validatedData,
              id: serverData.id,
              createdAt: serverData.createdAt,
              updatedAt: serverData.updatedAt,
            };

            queryClient.setQueryData(SETTINGS_QUERY_KEYS.settings, newSettings);
          },
        });

        toast.success(result.message || 'تم حفظ الإعدادات بنجاح');
      } catch (error) {
        toast.error(
          error instanceof CustomError ? error.message : 'حدث خطأ، أعد المحاولة'
        );
      }
    },
    [queryClient]
  );

  const onError = useCallback((errors: FieldErrors<SettingsInput>) => {
    const flatErrors = flattenErrors(errors);
    toast.error(
      (Object.values(flatErrors)[0] as string) || 'تحقق من صحة جميع الخانات'
    );
    useErrors.getState().setErrors(flatErrors);
  }, []);

  useEffect(() => {
    return () => {
      useErrors.getState().setErrors({});
      useTabsStore.getState().reset();
    };
  }, []);

  if (isLoading || !isFormHydrated) return <LoadingPage />;

  return (
    <FormProvider {...methods}>
      <form
        onSubmit={handleSubmit(onSubmit, onError)}
        className={cn(
          'transition-[max-width,opacity]',
          isSubmitting && 'disabled'
        )}
        inert={isSubmitting}
      >
        <Header
          title='إعدادات الموقع'
          loading={isSubmitting}
          cancelHref='/dash'
          containerClassName='border-b-0 mb-2'
        />

        {lastUpdated && (
          <p className='mb-4 text-sm text-muted-foreground'>
            آخر تحديث: {lastUpdated}
          </p>
        )}

        <MainTabs tabs={MAIN_TABS} />

        <SmoothHeightContainer className='px-1 pb-10 pt-4'>
          <FormContent />
        </SmoothHeightContainer>
      </form>
    </FormProvider>
  );
};

export default SettingsPage;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/settings',
      title: {
        template: 'إعدادات الموقع',
      },
    },
  };
}
