import { memo, useMemo } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { Check as _Check, X as _X } from 'lucide-react';
import { useWatch } from 'react-hook-form';
import { useShallow } from 'zustand/react/shallow';

import { inputMessageVariants } from '../anim';
import useAuthStore from '../store';

const Check = memo(_Check);
const X = memo(_X);

// Constants
const PASSWORD_REQUIREMENTS = [
  { regex: /.{8,}/, text: 'يجب أن تكون 8 أحرف على الأقل' },
  { regex: /[0-9]/, text: 'يجب أن تحتوي على رقم واحد على الأقل' },
  { regex: /[a-z]/, text: 'يجب أن تحتوي على حرف صغير واحد على الأقل' },
  { regex: /[A-Z]/, text: 'يجب أن تحتوي على حرف كبير واحد على الأقل' },
  { regex: /[^a-zA-Z0-9]/, text: 'يجب أن تحتوي على رمز خاص واحد على الأقل' },
] as const;

type StrengthScore = 0 | 1 | 2 | 3 | 4 | 5;

const STRENGTH_CONFIG = {
  colors: {
    0: 'bg-border',
    1: 'bg-red-500',
    2: 'bg-orange-500',
    3: 'bg-amber-500',
    4: 'bg-amber-700',
    5: 'bg-emerald-500',
  } satisfies Record<StrengthScore, string>,
  texts: {
    0: 'أدخل كلمة مرور',
    1: 'كلمة مرور ضعيفة',
    2: 'كلمة مرور متوسطة',
    3: 'كلمة مرور قوية!',
    4: 'كلمة مرور قوية جدا!!',
  } satisfies Record<Exclude<StrengthScore, 5>, string>,
} as const;

// Types
type Requirement = {
  met: boolean;
  text: string;
};

const PasswordStrength = memo(() => {
  const password = useWatch({ name: `password` });
  const isActive = useAuthStore(
    useShallow((state) => state.activeInput === 'password')
  );

  const calculateStrength = useMemo((): {
    score: StrengthScore;
    requirements: Requirement[];
  } => {
    const requirements = PASSWORD_REQUIREMENTS.map((req) => ({
      met: req.regex.test(password || ''),
      text: req.text,
    }));

    return {
      score: requirements.filter((req) => req.met).length as StrengthScore,
      requirements,
    };
  }, [password]);

  return (
    <AnimatePresence>
      {isActive && (
        <motion.div
          variants={inputMessageVariants}
          initial='initial'
          animate='animate'
          exit='exit'
          className='w-full select-none'
        >
          <div className='h-3' />
          <div
            className='mb-2 h-1 overflow-hidden rounded-full bg-border'
            role='progressbar'
            aria-valuenow={calculateStrength.score}
            aria-valuemin={0}
            aria-valuemax={4}
          >
            <div
              className={`h-full ${
                STRENGTH_CONFIG.colors[calculateStrength.score]
              } transition-all duration-500`}
              style={{ width: `${(calculateStrength.score / 5) * 100}%` }}
            />
          </div>

          <p
            id='password-strength'
            className='mb-2 flex justify-between text-sm'
          >
            <span className='font-medium'>يجب أن تحتوي على:</span>
            <span>
              {
                STRENGTH_CONFIG.texts[
                  Math.min(
                    calculateStrength.score,
                    4
                  ) as keyof typeof STRENGTH_CONFIG.texts
                ]
              }
            </span>
          </p>

          <ul className='space-y-1.5' aria-label='Password requirements'>
            {calculateStrength.requirements.map((req, index) => (
              <li key={index} className='flex items-center space-x-2'>
                {req.met ? (
                  <Check size={16} className='size-4 text-emerald-500' />
                ) : (
                  <X size={16} className='size-4 text-muted-foreground/80' />
                )}
                <span
                  className={`text-xs ${
                    req.met ? 'text-emerald-600' : 'text-muted-foreground'
                  }`}
                >
                  {req.text}
                  <span className='sr-only'>
                    {req.met ? ' - متحقق' : ' - غير متحقق'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

PasswordStrength.displayName = 'PasswordStrength';

export default PasswordStrength;
