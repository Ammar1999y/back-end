import type { Project } from '@/components/projects/types';
import type {
  UpdateProjectInput,
  UpdateProjectOutput,
} from '@/utils/validation/projects';
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
import { updateProjectSchema } from '@/utils/validation/projects';

import ErrorMessage from '@/components/error-message';
import { flattenErrors } from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import LoadingPage from '@/components/loading-page';
import { ProjectForm } from '@/components/projects/form';
import { PROJECTS_QUERY_KEYS } from '@/components/projects/query-keys';

const EditProject = () => {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { projectId: _id } = router.query;

  const id = useMemo(() => validID(_id), [_id]);
  console.log(id);

  const queryParams = useMemo(
    () => ({
      queryKey: PROJECTS_QUERY_KEYS.detail(id),
      href: `/api/dash/projects/${id}`,
      enabled: !!id,
      requiredData: !!id,
    }),
    [id]
  );

  const {
    data: projectData,
    isLoading,
    error,
    refetch,
  } = useQueryData<Project>(queryParams);

  const methods = useForm<UpdateProjectInput>({
    resolver: zodResolver(updateProjectSchema),
    disabled: loading,
    defaultValues: {
      id: undefined,
      title: '',
      description: '',
      link: '',
      categoryId: undefined,
      isActive: true,
    },
  });

  const { handleSubmit, reset, control } = methods;

  const watchedId = useWatch({
    control,
    name: 'id',
  });
  const isFormHydrated = useMemo(() => !!validID(watchedId), [watchedId]);

  // Reset form when project data is loaded
  useEffect(() => {
    if (projectData) {
      reset(projectData);
    }
  }, [projectData, reset]);

  const onSubmit = useCallback(
    async (data: UpdateProjectInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});

      // After validation, data is guaranteed to match UpdateProjectOutput
      const validatedData = data as UpdateProjectOutput;
      try {
        const result = await mutate<
          Pick<Project, 'updatedAt'>,
          UpdateProjectOutput
        >({
          href: `/api/dash/projects/${validatedData.id}`,
          method: 'PUT',
          data: validatedData,
          onSuccess: (serverData) => {
            const updatedProject: Project = {
              ...validatedData,
              updatedAt: serverData.updatedAt || new Date().toISOString(),
              createdAt: projectData?.createdAt || new Date().toISOString(),
            };

            // Update detail cache
            queryClient.setQueryData(
              PROJECTS_QUERY_KEYS.detail(validatedData.id),
              updatedProject
            );

            // Update list cache
            const existingList = queryClient.getQueryData<Project[]>(
              PROJECTS_QUERY_KEYS.list
            );
            if (existingList)
              queryClient.setQueryData(
                PROJECTS_QUERY_KEYS.list,
                existingList.map((item) =>
                  item.id === validatedData.id ? updatedProject : item
                )
              );
          },
        });

        toast.success(result.message || 'تم تحديث المشروع بنجاح');
        router.push('/dash/projects');
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
    [projectData, queryClient, router]
  );

  const onError = useCallback((errors: FieldErrors<UpdateProjectInput>) => {
    const erros = flattenErrors(errors);
    toast.error(
      (Object.values(erros)[0] as string) || 'تحقق من صحه جميع الخانات'
    );
    useErrors.getState().setErrors(erros);
  }, []);

  useEffect(() => {
    return () => {
      useErrors.getState().setErrors({});
    };
  }, []);

  return isLoading || !isFormHydrated ? (
    <LoadingPage />
  ) : projectData?.id ? (
    <FormProvider {...methods}>
      <form
        className={cn('transition-[max-width,opacity]', loading && 'disabled')}
        inert={loading}
        onSubmit={handleSubmit(onSubmit, onError)}
      >
        <Header
          title='تعديل بيانات المشروع'
          loading={loading}
          cancelHref='/dash/projects'
        />
        <ProjectForm />
      </form>
    </FormProvider>
  ) : (
    <ErrorMessage error={error || null} refetch={refetch} />
  );
};

export default EditProject;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/edit',
      title: {
        template: 'تعديل مشروع',
      },
    },
  };
}
