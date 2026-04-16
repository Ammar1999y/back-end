import { useRouter } from 'next/router';
import { useCallback, useState } from 'react';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';

interface FormState {
  name: string;
  email: string;
  password: string;
}

export default function Page() {
  const { replace } = useRouter();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<FormState>({
    name: '',
    email: '',
    password: '',
  });

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }, []);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLoading(true);
      try {
        const res = await fetch('/api/dev/sign-up', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'حدث خطأ');
        toast.success('تم إنشاء الحساب بنجاح');
        replace('/dash/sign-in');
      } catch (error: any) {
        toast.error(error?.message || 'حدث خطأ');
      }
      setLoading(false);
    },
    [form, replace]
  );

  return (
    <div className='flex min-h-screen w-full items-center justify-center'>
      <div className='w-full max-w-lg rounded-3xl bg-card px-6 pb-10 pt-6 text-card-foreground shadow-lg'>
        <h1 className='text-xl font-semibold'>إنشاء حساب (بيئة التطوير)</h1>
        <p className='mt-1 text-sm text-muted-foreground'>
          سيتم إنشاء حساب بصلاحيات نظام كاملة
        </p>
        <form onSubmit={onSubmit} className='mt-6 space-y-6' inert={loading}>
          <div>
            <Label title='الاسم' require htmlFor='name' />
            <Input
              id='name'
              name='name'
              type='text'
              autoFocus
              value={form.name}
              onChange={onChange}
              required
            />
          </div>
          <div>
            <Label title='البريد الإلكتروني' require htmlFor='email' />
            <Input
              id='email'
              name='email'
              type='email'
              dir='ltr'
              value={form.email}
              onChange={onChange}
              required
            />
          </div>
          <div>
            <Label title='كلمة المرور' require htmlFor='password' />
            <Input
              id='password'
              name='password'
              type='password'
              dir='ltr'
              value={form.password}
              onChange={onChange}
              required
            />
          </div>
          <Button type='submit' className='w-full' disabled={loading}>
            {loading ? 'جاري الإنشاء...' : 'إنشاء حساب'}
          </Button>
        </form>
      </div>
    </div>
  );
}

Page.hideSidebar = true;

export async function getStaticProps() {
  return {
    props: {
      pathname: '/dash/sign-up',
      title: {
        template: 'إنشاء حساب',
      },
    },
  };
}
