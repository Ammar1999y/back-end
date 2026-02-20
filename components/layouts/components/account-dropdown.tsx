import Link from 'next/link';
import { memo } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function AccountDropdown() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='icon' className='rounded-full'>
          <img
            className='h-6 w-6 rounded-full'
            src={'https://thispersondoesnotexist.com/'}
            alt=''
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className='w-56'>
        <div className='flex items-center p-2 space-x-2'>
          <img
            className='h-10 w-10 rounded-full'
            src={'https://thispersondoesnotexist.com/'}
            alt=''
          />
          <div className='flex flex-col items-start'>
            <div className='text-sm font-medium'>User Name</div>
            <div className='text-xs'>email@gmail.com</div>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href='#'>الصفحة الشخصية</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant='destructive' className='font-bold' asChild>
          <Link href='/dash/sign-in'>تسجيل الخروج</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default memo(AccountDropdown);
