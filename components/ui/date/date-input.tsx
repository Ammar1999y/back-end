import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

interface DateInputProps {
  value?: Date;
  /**
   * `undefined` means the bound was CLEARED. Emitting it is not optional: the
   * empty state is user-reachable, so a signature of `(date: Date) => void`
   * meant clearing every field updated only this input's own display while the
   * owner kept the old value — the UI said the bound was removed and Save
   * committed it anyway.
   */
  onChange: (date: Date | undefined) => void;
  className?: string;
}

const pad2 = (n: number) => n.toString().padStart(2, '0');
const daysInMonth = (y: number, m1to12: number) =>
  new Date(y, m1to12, 0).getDate();

type DParts = { day: string; month: string; year: string };

/**
 * Rendered when the bound genuinely has no value. An open-ended range ("up to
 * Aug 5") is a normal state — starting from an empty filter and editing only
 * the upper input produces it — and defaulting the empty side to today showed
 * the user a lower bound that was not part of their filter at all.
 */
const EMPTY_PARTS: DParts = { day: '', month: '', year: '' };

const toPartsFromDate = (d: Date): DParts => ({
  day: pad2(d.getDate()),
  month: pad2(d.getMonth() + 1),
  year: d.getFullYear().toString(),
});

const toDateFromParts = (p: DParts) =>
  new Date(Number(p.year), Number(p.month) - 1, Number(p.day));

/**
 * Identity of an emitted value, for suppressing duplicate notifications.
 *
 * Numeric, not the raw strings: `'5'` and `'05'` are the same day, and keying
 * on the literals made a single-digit entry emit once before blur padded it and
 * again after. `CLEARED_KEY` is the same idea for the empty state.
 */
const partsKey = (p: DParts) =>
  `${Number(p.year)}-${Number(p.month)}-${Number(p.day)}`;
const CLEARED_KEY = 'cleared';

/**
 * A parseable value is not necessarily a COMMITTED one.
 *
 * Typing `1` into a filled day field produces the valid date "the 1st", so it
 * was emitted immediately; the controlled parent echoed it back, the sync effect
 * padded the field to `01`, and `maxLength={2}` then refused the `5` the user
 * was about to type — `15` was unreachable. Editing day or month on a complete
 * date was impossible for every value except those starting with `0`.
 *
 * A single digit is therefore held as provisional text: blur pads it and commits
 * it (`handleBlur`), and two digits commit straight away. Arrow adjustment is
 * unaffected — it always produces padded parts.
 */
const isCommittableParts = (d: DParts) =>
  d.day.length === 2 && d.month.length === 2 && d.year.length === 4;

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
  // Stepping an empty input starts from today, not the year 2000: with a real
  // empty state the previous fallback would have jumped to 2000-01-01.
  const today = new Date();
  const y = Number(parts.year) || today.getFullYear();
  const m = (Number(parts.month) || today.getMonth() + 1) - 1;
  const d = Number(parts.day) || today.getDate();

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
    value ? toPartsFromDate(new Date(value)) : EMPTY_PARTS
  );
  const lastValidRef = useRef<DParts>(date);
  // Seeded from the initial value for the same reason the effect resyncs it:
  // the owner already holds this date, so re-entering it is not a change.
  // Completing a field auto-focuses the next one, and that focus fires blur
  // synchronously with a stale render closure — so the same finished date was
  // emitted twice for one keystroke. Consumers here are idempotent, but an
  // exported component should not double-fire its own contract.
  const lastEmittedRef = useRef<string>(
    value ? partsKey(date) : CLEARED_KEY
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dayRef = useRef<HTMLInputElement | null>(null);
  const monthRef = useRef<HTMLInputElement | null>(null);
  const yearRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const next = value ? toPartsFromDate(new Date(value)) : EMPTY_PARTS;
    lastValidRef.current = next;
    // The de-dupe key MUST resync with the incoming value. Leaving it behind
    // meant that after the owner changed the value another way — Cancel, or a
    // calendar click — retyping the date this input had previously emitted was
    // suppressed as a duplicate, so the field displayed one date while the
    // owner still held another and Save committed the wrong one.
    lastEmittedRef.current = value ? partsKey(next) : CLEARED_KEY;
    setDate(next);
  }, [value]);

  /**
   * The single place a value change is reported. Both terminal states are
   * handled here — a complete date, and a fully empty one.
   *
   * "Cleared" used to be reachable only from the blur handler, which made the
   * owner's knowledge depend on focus moving. Anything that reads the committed
   * value without an intervening blur then saw the old date while the field
   * showed nothing. Depending on incidental event ordering is the same mistake
   * that produced several earlier defects here, so emptiness is now reported
   * when it happens, exactly like completeness is.
   */
  const setAndMaybeEmit = (next: DParts) => {
    if (
      next.day === date.day &&
      next.month === date.month &&
      next.year === date.year
    )
      return;
    setDate(next);

    if (!next.day && !next.month && !next.year) {
      lastValidRef.current = EMPTY_PARTS;
      // Guarded because tabbing across an already-empty input blurs each field
      // in turn, and the owner should be told once.
      if (lastEmittedRef.current === CLEARED_KEY) return;
      lastEmittedRef.current = CLEARED_KEY;
      onChange(undefined);
      return;
    }

    if (isValidParts(next)) {
      lastValidRef.current = next;
      // Valid but still being typed (`1` for `15`): keep it local. Emitting it
      // would round-trip through the parent and pad the field mid-keystroke.
      if (!isCommittableParts(next)) return;
      const key = partsKey(next);
      if (lastEmittedRef.current === key) return;
      lastEmittedRef.current = key;
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
      // Normalizes ONLY the field being left, and takes the others from state
      // as-is. The previous version padded every empty sibling to '00', which
      // made a partially typed date fail validation and get reset — and since
      // completing the day auto-focuses the month, that blur fired on every
      // single entry attempt. With a genuinely empty initial state that made
      // an empty input impossible to fill in by hand.
      const raw = e.target.value;
      const padded = raw ? pad2(Number(raw) || 0) : '';
      const next: DParts = {
        day: field === 'day' ? padded : date.day,
        month: field === 'month' ? padded : date.month,
        year: field === 'year' ? raw : date.year,
      };

      // Fully empty is a legitimate "no bound", not a mistake to undo.
      // `setAndMaybeEmit` owns that transition; if the state is already empty
      // its equality check makes this a no-op.
      if (!next.day && !next.month && !next.year)
        return setAndMaybeEmit(next);

      // Reject only a COMPLETE but impossible date (31/02, month 13). An
      // in-progress one is preserved so the user can carry on typing.
      const complete = !!next.day && !!next.month && next.year.length === 4;
      if (complete && !isValidParts(next)) {
        setDate(lastValidRef.current);
        return;
      }

      setAndMaybeEmit(next);
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
        // No readiness gate: `adjust` fills missing parts from today, so the
        // arrows also work as a way to START entering a date. The gate existed
        // because the old fallback produced the year 2000 — with an empty
        // initial state it made the arrows dead on an unset bound.
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

  /**
   * Focus leaving the whole control discards an unfinished date.
   *
   * A partial value is fine *while editing*, but it must not survive the user
   * moving on: Save commits the owner's value, and the owner never saw the
   * partial edit — so the field would display one date while a different one
   * was committed. Reverting on FIELD blur is what broke entry earlier (moving
   * day -> month is a blur), so this is scoped to leaving the container: an
   * internal focus move is not leaving.
   */
  const handleContainerBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget && containerRef.current?.contains(e.relatedTarget))
      return;

    const hasAnyInput = !!(date.day || date.month || date.year);
    // All-empty is the cleared state, already reported to the owner.
    if (hasAnyInput && !isValidParts(date)) setDate(lastValidRef.current);
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
      ref={containerRef}
      onBlur={handleContainerBlur}
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
