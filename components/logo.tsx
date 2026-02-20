import Link from 'next/link';
import { memo } from 'react';

import { cn } from '@/lib/utils';

interface Props {
  size?: number | string;
  className?: string;
}
const Logo = memo(({ className }: Props) => {
  return (
    <Link
      href='/dash'
      className={cn(
        'flex rounded-md p-0.5 text-primary transition duration-300',
        className
      )}
      aria-label='شعار الموقع'
    >
      <svg
        width={'64'}
        height={'64'}
        aria-label='شعار الموقع'
        className='h-full w-auto max-w-full'
        viewBox='0 0 64 64'
        fill='none'
        xmlns='http://www.w3.org/2000/svg'
      >
        <path
          d='M54.5571 14.0482V26.2295L31.9323 12.1918L9.89882 25.8853L9.60836 25.6872L9.44238 14.0377L31.922 0L54.5571 14.0482Z'
          fill='#00686E'
          stroke='#00686E'
          strokeWidth='0.25'
          strokeMiterlimit='10'
        />
        <path
          d='M9.44238 49.9518V37.7705L32.0672 51.8082L54.277 37.9374L54.5571 38.146V49.9623L32.0776 64L9.44238 49.9518Z'
          fill='#02B199'
        />
        <path
          d='M64 42.6124V54.5574L54.9992 49.9014L44.2215 44.3035L9.36044 26.2469L9.00083 26.0543L0 21.3876V9.44263L9.00083 14.0986L19.7786 19.6965L54.6396 37.7531L54.9992 37.9457L64 42.6124Z'
          fill='#02B199'
        />
        <path
          d='M64 42.6124V54.5574L54.9992 49.9014L44.2215 44.3035L9.36044 26.2469L9.00083 26.0543L0 21.3876V9.44263L9.00083 14.0986L19.7786 19.6965L54.6396 37.7531L54.9992 37.9457L64 42.6124Z'
          fill='#02B199'
        />
      </svg>
    </Link>
  );
});

Logo.displayName = 'Logo';

export default Logo;
