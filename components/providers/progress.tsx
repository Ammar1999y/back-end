import { useMemo } from 'react';

import { ProgressProvider as _ProgressProvider } from '@bprogress/next/pages';

const ProgressProvider = ({
  children,
  dir,
}: {
  children: React.ReactNode;
  dir: string;
}) => {
  const options = useMemo(
    () => ({
      showSpinner: false,
      direction: dir as 'rtl' | 'ltr',
    }),
    [dir]
  );
  return (
    <_ProgressProvider
      height='4px'
      color='hsl(var(--primary))'
      options={options}
      shallowRouting
    >
      {children}
    </_ProgressProvider>
  );
};

export default ProgressProvider;
