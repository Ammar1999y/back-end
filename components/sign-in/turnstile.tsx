import type { TurnstileInstance } from '@marsidev/react-turnstile';

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { Turnstile as _Turnstile } from '@marsidev/react-turnstile';
import { useTheme } from 'next-themes';
import { useFormContext } from 'react-hook-form';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { useErrors } from '@/utils/store/errors';
import { LoginFormData } from '@/utils/validation/auth';

const Turnstile = memo(_Turnstile);

const scriptOptions = {
  id: `turnstile-script`,
};

interface TurnstileWidgetProps {
  reset: boolean;
  setReset: (value: boolean) => void;
}

const TurnstileWidget = memo(({ reset, setReset }: TurnstileWidgetProps) => {
  const [options, setOptions] = useState<any>({
    theme: 'light',
    language: 'ar',
    size: 'flexible',
  });
  const { theme, resolvedTheme } = useTheme();

  useEffect(() => {
    setOptions((prev: any) => ({
      ...prev,
      theme: (resolvedTheme || theme) === 'dark' ? 'dark' : 'light',
    }));
  }, [theme, resolvedTheme]);

  const errorMessage = useErrors(useShallow((state) => state.errors));
  const ref = useRef<TurnstileInstance>(null);
  const [remove, setRemove] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const { setValue } = useFormContext<LoginFormData>();
  useEffect(() => {
    if (remove || errorMessage?.captcha) {
      const script = document.getElementById(scriptOptions.id);
      if (script) {
        script?.remove();
      }
      setTimeout(() => {
        ref.current?.render();
        ref.current?.execute();
        ref.current?.reset();
        setRemove(false);
      }, 500);
    }
  }, [remove, errorMessage]);

  useEffect(() => {
    if (reset || Object.keys(errorMessage).length > 0) {
      ref.current?.reset();
      setReset(false);
    }
  }, [reset, errorMessage, setReset]);

  const onSuccess = useCallback(
    (e: string) => {
      if (typeof e === 'string') setValue('captcha', e);
    },
    [setValue]
  );

  const onUnsupported = useCallback(() => {
    toast.error(
      'المتصفح غير مدعوم، قم بتغير المتصفح او استخدام اخر نسخة للمتابعة.',
      {
        duration: 20_000,
      }
    );
  }, []);

  const onError = useCallback(() => {
    setRemove(true);
  }, [setRemove]);

  const resetTurnstile = useCallback(() => {
    ref.current?.reset();
  }, [ref]);

  const onWidgetLoad = useCallback(() => {
    setLoaded(true);
  }, [setLoaded]);

  useEffect(() => {
    if (loaded) return;
    const interval = setInterval(() => {
      setRemove(true);
    }, 8000);
    return () => clearInterval(interval);
  }, [loaded]);

  return (
    <Turnstile
      key={!remove + ' ' + !remove}
      ref={ref}
      siteKey={
        process.env.NODE_ENV === 'development'
          ? '1x00000000000000000000AA'
          : process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!
      }
      scriptOptions={scriptOptions}
      options={options}
      onError={onError}
      onExpire={resetTurnstile}
      onTimeout={resetTurnstile}
      onSuccess={onSuccess}
      onUnsupported={onUnsupported}
      onWidgetLoad={onWidgetLoad}
    />
  );
});

TurnstileWidget.displayName = 'TurnstileWidget';

export default TurnstileWidget;
