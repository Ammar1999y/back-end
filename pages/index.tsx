import { useRouter } from 'next/router';
import { useEffect } from 'react';

export default function Page() {
  const { replace } = useRouter();
  useEffect(() => {
    replace('/dash/sign-in');
  }, [replace]);

  return <></>;
}
