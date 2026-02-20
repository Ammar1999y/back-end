import { useRouter } from 'next/router';
import { useEffect } from 'react';

export default function Custom404() {
  const router = useRouter();
  useEffect(() => {
    router.push('/');
  }, [router]);
  return (
    <div className='flex h-screen flex-col items-center justify-center text-black'>
      <h1 className='text-4xl font-bold'>404 - Page Not Found</h1>
    </div>
  );
}
