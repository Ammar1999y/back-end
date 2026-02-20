/* eslint-disable react-hooks/refs */
import { memo } from 'react';

import { useFormContext, useWatch } from 'react-hook-form';

import { Switch as _Switch } from '@/components/ui/switch';

const Switch = ({ name, ariaLabel }: { name: string; ariaLabel: string }) => {
  const { register, setValue } = useFormContext();
  const statusValue = useWatch({
    name,
  });

  return (
    <_Switch
      checked={statusValue}
      onCheckedChange={(checked) => setValue(name, checked)}
      className='peer absolute inset-0 !z-[0] h-[inherit] w-[inherit] [&_span]:z-[1] [&_span]:size-8 [&_span]:transition-[cubic-bezier(0.16,1,0.3,1)] [&_span]:duration-300 [&_span]:data-[state=checked]:translate-x-11 [&_span]:data-[state=checked]:rtl:-translate-x-11'
      aria-label={ariaLabel}
      ref={register(name).ref}
      name={register(name).name}
      id={register(name).name}
      disabled={register(name).disabled}
      onBlur={register(name).onBlur}
    />
  );
};

interface StatusSwitchProps {
  name: string;
  ariaLabel: string;
  labels?: {
    checked?: string;
    unchecked?: string;
  };
}

const StatusSwitch = memo(({ name, ariaLabel, labels }: StatusSwitchProps) => {
  const checkedLabel = labels?.checked ?? 'نشط';
  const uncheckedLabel = labels?.unchecked ?? 'موقف';

  return (
    <div className='relative h-9 w-20 scale-90 overflow-hidden text-xs'>
      <Switch name={name} ariaLabel={ariaLabel} />
      <span className='pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center justify-center text-foreground transition-[opacity,transform] duration-200 peer-data-[state=checked]:opacity-0 peer-data-[state=unchecked]:opacity-100 ltr:right-1.5 peer-data-[state=checked]:ltr:-translate-x-10 peer-data-[state=unchecked]:ltr:-translate-x-1 rtl:left-1.5 peer-data-[state=checked]:rtl:translate-x-10 peer-data-[state=unchecked]:rtl:translate-x-1'>
        {uncheckedLabel}
      </span>

      <span className='pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center justify-center transition-[opacity,transform] duration-200 peer-data-[state=checked]:text-primary-foreground peer-data-[state=checked]:opacity-100 peer-data-[state=unchecked]:opacity-0 ltr:left-1.5 peer-data-[state=checked]:ltr:translate-x-1 peer-data-[state=unchecked]:ltr:translate-x-10 rtl:right-1.5 peer-data-[state=checked]:rtl:-translate-x-1 peer-data-[state=unchecked]:rtl:-translate-x-10'>
        {checkedLabel}
      </span>
    </div>
  );
});

StatusSwitch.displayName = 'StatusSwitch';
export default StatusSwitch;
