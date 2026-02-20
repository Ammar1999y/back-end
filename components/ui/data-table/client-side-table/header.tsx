import { memo } from 'react';

import { PlusIcon } from 'lucide-react';

import { Link } from '@/components/ui/link';

const Header = memo(
  ({
    title,
    cta,
  }: {
    title: string;
    cta?: { href: string; label: string };
  }) => {
    return (
      <div className='mb-10 mt-4 flex justify-between'>
        <h1 className='mb-1 text-3xl font-bold'>{title}</h1>
        {!!cta?.href && (
          <Link
            href={cta.href}
            className='self-end font-semibold shadow-lg shadow-primary/15 md:font-bold'
          >
            <PlusIcon className='size-4' />
            <span>{cta.label}</span>
          </Link>
        )}
      </div>
    );
  }
);

Header.displayName = 'Header';
export default Header;
