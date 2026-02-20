import type { NavProps } from '@/components/nav/types';

import { memo, useCallback } from 'react';

import { APP_NAME } from '@/constants';
import { X } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import { useModules } from '@/utils/store/modules';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import Menu from '@/components/icons/menu';
import Logo from '@/components/logo';
import ModuleTrigger from '@/components/modules/module-trigger';
import { NavVertical } from '@/components/nav';

export const MODULE_ID = 'mobileMenu';

const NavMobileLayout = memo(({ data }: NavProps) => {
  const isOpen = useModules(
    useShallow((s) => s.openModules.includes(MODULE_ID))
  );
  const addModule = useModules(useShallow((s) => s.addModule));
  const removeModule = useModules(useShallow((s) => s.removeModule));
  const onOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) addModule(MODULE_ID);
      else removeModule(MODULE_ID);
    },
    [addModule, removeModule]
  );

  const close = useCallback(
    () => useModules.getState().removeModule(MODULE_ID),
    []
  );

  return (
    <Dialog modal={false} open={isOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <ModuleTrigger name={MODULE_ID} variant='ghost' size='icon'>
          <Menu size={24} className='size-6' />
        </ModuleTrigger>
      </DialogTrigger>
      <DialogContent side='right' className='w-72 px-2 [&>button]:hidden'>
        <div className='flex h-[--layout-header-height] items-center pb-4 pe-2 ps-6 pt-[calc((var(--spacing)*4)+env(safe-area-inset-top))] space-x-4'>
          <Logo size={50} className='h-full max-w-12' />
          <span className='text-xl font-bold'>{APP_NAME}</span>
          <div className='flex flex-1'>
            <Button
              variant='outline'
              size='icon'
              onClick={close}
              className='ms-auto h-8 w-8'
            >
              <X className='h-4 w-4' />
            </Button>
          </div>
        </div>
        <ScrollArea className='h-full'>
          <NavVertical data={data} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
});

NavMobileLayout.displayName = 'NavMobileLayout';
export { NavMobileLayout };
// import type { NavProps } from '@/components/nav/types';

// import { memo } from 'react';

// import { APP_NAME } from '@/constants';

// import { Button } from '@/components/ui/button';
// import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
// import { ScrollArea } from '@/components/ui/scroll-area';
// import Menu from '@/components/icons/menu';
// import Logo from '@/components/logo';
// import { NavVertical } from '@/components/nav';

// const NavMobileLayout = memo(({ data }: NavProps) => {
//   return (
//     <Dialog modal={false}>
//       <DialogTrigger asChild>
//         <Button variant='ghost' size='icon'>
//           <Menu size={24} className='size-6' />
//         </Button>
//       </DialogTrigger>
//       <DialogContent side='right' className='w-72 px-2 [&>button]:hidden'>
//         <div className='flex h-[--layout-header-height] items-center pb-4 pe-2 ps-6 pt-[calc((var(--spacing)*4)+env(safe-area-inset-top))] space-x-4'>
//           <Logo size={50} className='h-full max-w-12' />
//           <span className='text-xl font-bold'>{APP_NAME}</span>
//         </div>
//         <ScrollArea className='h-full'>
//           <NavVertical data={data} />
//         </ScrollArea>
//       </DialogContent>
//     </Dialog>
//   );
// });

// NavMobileLayout.displayName = 'NavMobileLayout';
// export { NavMobileLayout };
