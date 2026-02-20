import { memo } from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import Setting from '@/components/icons/setting';
import ModuleTrigger from '@/components/modules/module-trigger';
import { MODULE_ID } from '@/components/theme-customizer';

const SettingButton = memo(() => {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ModuleTrigger name={MODULE_ID} variant='ghost' size='icon'>
          <Setting size={24} className='size-6 animate-slow-spin' />
        </ModuleTrigger>
      </TooltipTrigger>
      <TooltipContent>
        <p className='text-sm'>تخصيص شكل الواجهه</p>
      </TooltipContent>
    </Tooltip>
  );
});

SettingButton.displayName = 'SettingButton';

export default SettingButton;
