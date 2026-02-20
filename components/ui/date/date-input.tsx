import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

interface DateInputProps {
  value?: Date;
  onChange: (date: Date) => void;
  className?: string;
}

const pad2 = (n: number) => n.toString().padStart(2, '0');
const daysInMonth = (y: number, m1to12: number) =>
  new Date(y, m1to12, 0).getDate();

type DParts = { day: string; month: string; year: string };

const toPartsFromDate = (d: Date): DParts => ({
  day: pad2(d.getDate()),
  month: pad2(d.getMonth() + 1),
  year: d.getFullYear().toString(),
});

const toDateFromParts = (p: DParts) =>
  new Date(Number(p.year), Number(p.month) - 1, Number(p.day));

const isValidParts = (d: DParts) => {
  const day = Number(d.day);
  const month = Number(d.month);
  const year = Number(d.year);
  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year)
  )
    return false;
  if (year < 1000 || year > 9999 || month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
};

const adjust = (parts: DParts, field: keyof DParts, step: 1 | -1): DParts => {
  const y = Number(parts.year) || 2000;
  const m = (Number(parts.month) || 1) - 1;
  const d = Number(parts.day) || 1;

  let dt = new Date(y, m, d);

  if (field === 'day') {
    dt.setDate(dt.getDate() + step);
  } else if (field === 'month') {
    const origDay = dt.getDate();
    dt.setDate(1);
    dt.setMonth(dt.getMonth() + step);

    const dim = daysInMonth(dt.getFullYear(), dt.getMonth() + 1);
    dt.setDate(Math.min(origDay, dim));
  } else {
    const newY = Math.min(9999, Math.max(1000, dt.getFullYear() + step));
    const dim = daysInMonth(newY, dt.getMonth() + 1);
    dt = new Date(newY, dt.getMonth(), Math.min(dt.getDate(), dim));
  }

  const boundedYear = Math.min(9999, Math.max(1000, dt.getFullYear()));
  dt = new Date(boundedYear, dt.getMonth(), dt.getDate());

  return toPartsFromDate(dt);
};
const DateInput = memo<DateInputProps>(({ value, onChange, className }) => {
  const [date, setDate] = useState<DParts>(() =>
    toPartsFromDate(value ? new Date(value) : new Date())
  );
  const lastValidRef = useRef<DParts>(date);

  const dayRef = useRef<HTMLInputElement | null>(null);
  const monthRef = useRef<HTMLInputElement | null>(null);
  const yearRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const d = value ? new Date(value) : new Date();
    const next = toPartsFromDate(d);
    lastValidRef.current = next;
    setDate(next);
  }, [value]);

  const setAndMaybeEmit = (next: DParts) => {
    if (
      next.day === date.day &&
      next.month === date.month &&
      next.year === date.year
    )
      return;
    setDate(next);
    if (isValidParts(next)) {
      lastValidRef.current = next;
      onChange(toDateFromParts(next));
    }
  };

  const handleInputChange =
    (field: keyof DParts) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value.replace(/\D/g, '');
      const maxLen = field === 'year' ? 4 : 2;
      const next = { ...date, [field]: raw.slice(0, maxLen) };
      setAndMaybeEmit(next);

      if (raw.length === maxLen) {
        if (field === 'day') monthRef.current?.focus();
        else if (field === 'month') yearRef.current?.focus();
      }
    };

  const handleBlur =
    (field: keyof DParts) => (e: React.FocusEvent<HTMLInputElement>) => {
      const val = e.target.value;
      if (!val) return setDate(lastValidRef.current);

      const normalized: DParts = {
        ...date,
        day:
          field === 'day'
            ? pad2(Number(date.day) || 0)
            : pad2(Number(date.day) || 0),
        month:
          field === 'month'
            ? pad2(Number(date.month) || 0)
            : pad2(Number(date.month) || 0),
        year: field === 'year' ? date.year || '' : date.year || '',
      };

      if (/^\d{1,4}$/.test(normalized.year) && normalized.year.length < 4) {
      }
      if (!isValidParts(normalized)) return setDate(lastValidRef.current);
      setAndMaybeEmit(normalized);
    };

  const handleKeyDown =
    (field: keyof DParts) => (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.metaKey || e.ctrlKey) return;

      const allowed = [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Delete',
        'Tab',
        'Backspace',
        'Enter',
      ];
      if (!/^\d$/.test(e.key) && !allowed.includes(e.key)) {
        e.preventDefault();
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const y0 = Number(date.year || '0'),
          m0 = Number(date.month || '0'),
          d0 = Number(date.day || '0');
        const ready = y0 >= 1 && m0 >= 1 && d0 >= 1;
        if (!ready) return;

        e.preventDefault();
        const next = adjust(date, field, e.key === 'ArrowUp' ? 1 : -1);
        setAndMaybeEmit(next);
        return;
      }

      const selStart = e.currentTarget.selectionStart ?? 0;
      const selEnd = e.currentTarget.selectionEnd ?? 0;
      if (e.key === 'ArrowRight') {
        if (
          selStart === e.currentTarget.value.length ||
          (selStart === 0 && selEnd === e.currentTarget.value.length)
        ) {
          e.preventDefault();
          if (field === 'month') dayRef.current?.focus();
          else if (field === 'year') monthRef.current?.focus();
        }
      } else if (
        e.key === 'ArrowLeft' &&
        (selStart === 0 ||
          (selStart === 0 && selEnd === e.currentTarget.value.length))
      ) {
        e.preventDefault();
        if (field === 'day') monthRef.current?.focus();
        else if (field === 'month') yearRef.current?.focus();
      }
    };

  const onClick = useCallback((e: React.MouseEvent<HTMLInputElement>) => {
    e.stopPropagation();
    e.preventDefault();
  }, []);
  const onFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    if (typeof window !== 'undefined' && window.innerWidth > 1024)
      e.target.select();
  }, []);
  return (
    <div
      className={cn(
        'num flex items-center rounded border p-1 text-sm',
        className
      )}
    >
      <input
        type='text'
        ref={dayRef}
        inputMode='numeric'
        pattern='[0-9]*'
        maxLength={2}
        value={date.day}
        onChange={handleInputChange('day')}
        onKeyDown={handleKeyDown('day')}
        onFocus={onFocus}
        onClick={onClick}
        dir='ltr'
        onBlur={handleBlur('day')}
        className='bidi-isolate w-7 border-none p-0 text-center caret-primary outline-none'
        placeholder='D'
        aria-label='Day'
      />
      <span className='-mx-px opacity-20'>/</span>
      <input
        type='text'
        ref={monthRef}
        dir='ltr'
        inputMode='numeric'
        pattern='[0-9]*'
        maxLength={2}
        value={date.month}
        onChange={handleInputChange('month')}
        onKeyDown={handleKeyDown('month')}
        onFocus={onFocus}
        onClick={onClick}
        onBlur={handleBlur('month')}
        className='bidi-isolate w-6 border-none p-0 text-center caret-primary outline-none'
        placeholder='M'
        aria-label='Month'
      />
      <span className='-mx-px opacity-20'>/</span>
      <input
        type='text'
        dir='ltr'
        ref={yearRef}
        inputMode='numeric'
        pattern='[0-9]*'
        maxLength={4}
        value={date.year}
        onChange={handleInputChange('year')}
        onKeyDown={handleKeyDown('year')}
        onFocus={onFocus}
        onClick={onClick}
        onBlur={handleBlur('year')}
        className='bidi-isolate w-12 border-none p-0 text-center caret-primary outline-none'
        placeholder='YYYY'
        aria-label='Year'
      />
    </div>
  );
});

DateInput.displayName = 'DateInput';

export { DateInput };
