import { useRouter } from 'next/router';
import { useEffect } from 'react';

export default function ErrorPage() {
  const router = useRouter();
  useEffect(() => {
    router.push('/');
  }, [router]);
  return (
    <div className='flex h-screen flex-col items-center justify-center text-black'>
      <h1 className='text-4xl font-bold'>500 - Server-side error occurred</h1>
    </div>
  );
}
