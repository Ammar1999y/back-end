import type { Project } from '@/components/projects/types';
import type { CreateProjectInput } from '@/utils/validation/projects';
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
  CreateProjectOutput,
  createProjectSchema,
} from '@/utils/validation/projects';

import {
  flattenErrors,
  showFormErrors,
} from '@/components/form/form-error-handeling';
import { Header } from '@/components/form/header';
import { ProjectForm } from '@/components/projects/form';
import { PROJECTS_QUERY_KEYS } from '@/components/projects/query-keys';

const NewProject = () => {
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();

  const methods = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    disabled: loading,
    defaultValues: {
      title: '',
      description: '',
      link: '',
      categoryId: undefined,
      isActive: true,
    },
  });

  const { handleSubmit } = methods;

  const onSubmit = useCallback(
    async (data: CreateProjectInput) => {
      setLoading(true);
      useErrors.getState().setErrors({});
      // After validation, data is guaranteed to match CreateProjectOutput
      const validatedData = data as CreateProjectOutput;

      try {
        const result = await mutate<
          Pick<Project, 'id' | 'createdAt'>,
          CreateProjectOutput
        >({
          href: '/api/dash/projects',
          method: 'POST',
          data: validatedData,
          onSuccess: (serverData) => {
            const newProject: Project = {
              ...validatedData,
              id: serverData.id,
              createdAt: serverData.createdAt,
            };
            const existingProjects = queryClient.getQueryData<Project[]>(
              PROJECTS_QUERY_KEYS.list
            );
            queryClient.setQueryData(
              PROJECTS_QUERY_KEYS.detail(serverData.id),
              newProject
            );
            if (existingProjects)
              queryClient.setQueryData(PROJECTS_QUERY_KEYS.list, [
                newProject,
                ...existingProjects,
              ]);
          },
        });

        toast.success(result.message || 'تم إنشاء المشروع بنجاح');
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
    [queryClient, router]
  );

  const onError = useCallback((errors: FieldErrors<CreateProjectInput>) => {
    const erros = flattenErrors(errors);
    showFormErrors(erros);
    useErrors.getState().setErrors(erros);
  }, []);

  useEffect(() => {
    return () => {
      useErrors.getState().setErrors({});
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
          title='إضافة مشروع جديد'
          loading={loading}
          cancelHref='/dash/projects'
        />
        <ProjectForm />
      </form>
    </FormProvider>
  );
};

export default NewProject;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/projects/new',
      title: {
        template: 'إضافة مشروع',
      },
    },
  };
}
