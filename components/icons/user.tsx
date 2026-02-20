import { memo } from 'react';

const User = memo(
  ({
    className,
    width,
    height,
  }: {
    className?: string;
    width?: number;
    height?: number;
  }) => {
    return (
      <svg
        width={width || '24'}
        height={height || '24'}
        aria-hidden
        className={className}
        xmlns='http://www.w3.org/2000/svg'
        viewBox='0 0 24 24'
      >
        <circle cx='12' cy='6' r='4' fill='currentColor' />
        <path
          fill='currentColor'
          d='M20 17.5c0 2.485 0 4.5-8 4.5s-8-2.015-8-4.5S7.582 13 12 13s8 2.015 8 4.5'
          opacity='0.5'
        />
      </svg>
    );
  }
);

User.displayName = 'User';
export default User;
