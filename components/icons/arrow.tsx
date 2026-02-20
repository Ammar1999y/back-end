import { memo } from 'react';

const Arrow = memo(({ className }: { className: string }) => {
  return (
    <svg
      viewBox='0 0 18 18'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
      className={className}
    >
      <path
        d='M4.49651 17.6003C5.02918 18.133 5.89288 18.133 6.42553 17.6003L13.0921 10.9271C14.1565 9.86169 14.1561 8.13511 13.0912 7.07008L6.42062 0.399509C5.88797 -0.13317 5.02427 -0.13317 4.49159 0.399509C3.9589 0.932201 3.9589 1.79585 4.49159 2.32854L10.2009 8.03785C10.7337 8.5705 10.7337 9.4342 10.2009 9.96686L4.49651 15.6713C3.96382 16.204 3.96382 17.0676 4.49651 17.6003Z'
        fill='currentColor'
      />
    </svg>
  );
});

Arrow.displayName = 'Arrow';

export default Arrow;
