import { useCallback, useEffect, useRef } from 'react';

import { useShallow } from 'zustand/shallow';

import { useModules } from '@/utils/store/modules';

import { Button, ButtonProps } from '@/components/ui/button';

import { ModulesNames } from './modules-handler';

type ModuleTriggerProps = {
  name: ModulesNames;
  children: React.ReactNode;
  onClick?: () => void;
  disableFocus?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
} & ButtonProps;

const ModuleTrigger = ({
  name,
  children,
  onClick,
  disableFocus = false,
  ref,
  ...props
}: ModuleTriggerProps) => {
  const isOpen = useModules(
    useShallow((state) => state.openModules.includes(name))
  );
  const hasOpenedOnce = useRef(false);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) hasOpenedOnce.current = true;
    else if (hasOpenedOnce.current && triggerButtonRef.current && !disableFocus)
      setTimeout(() => triggerButtonRef.current?.focus(), 300);
  }, [isOpen, disableFocus]);

  const onClickHandler = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (typeof onClick === 'function') onClick(e);
      useModules.getState().addModule(name);
    },
    [name, onClick]
  );

  return (
    <Button
      ref={(node) => {
        triggerButtonRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      onClick={onClickHandler}
      {...props}
    >
      {children}
    </Button>
  );
};

export default ModuleTrigger;
