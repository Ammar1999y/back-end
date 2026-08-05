import { calendarDayInZone, safeDate } from '@/utils/time';

export const formatDate = (
  date: Date,
  locale: string = 'ar-u-ca-gregory'
): string => {
  return date.toLocaleDateString(locale, {
    day: '2-digit',
    month: 'numeric',
    year: 'numeric',
    numberingSystem: 'latn', // أرقام إنجليزية
  });
};

/**
 * Render a stored timestamp as its BUSINESS_TIMEZONE calendar day.
 *
 * Must use the same zone the server resolves date filters in. With
 * `toISOString()` this rendered the UTC day, so a row at 22:00 UTC on Aug 1
 * displayed "2026-08-01" while the Riyadh "Aug 2" filter correctly matched it
 * — the table appeared to return rows outside the selected range.
 */
export const tableFormatDate = (date: string | null): string => {
  if (!date) return '-';
  const parsed = safeDate(date);
  if (!parsed) return '-';
  return calendarDayInZone(parsed);
};

export const getDateAdjustedForTimezone = (dateInput: Date | string): Date => {
  if (typeof dateInput === 'string') {
    const parts = dateInput.split('-').map((part) => Number.parseInt(part, 10));
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return date;
  } else {
    return dateInput;
  }
};

/**
 * "Today" anchored to BUSINESS_TIMEZONE, returned as a local `Date` at
 * midnight of that calendar day.
 *
 * Presets built from a bare `new Date()` use the browser's calendar day, so a
 * user east of the business zone could pick "today" and get tomorrow's
 * business date. Anchoring here and keeping the rest of the arithmetic in
 * local time means the day-of-month/day-of-week maths below is unchanged and
 * `toCalendarDateValue` still round-trips to the intended day.
 */
const businessToday = (): Date => {
  const [year, month, day] = calendarDayInZone(new Date())
    .split('-')
    .map(Number);
  return new Date(year, month - 1, day);
};

export const getPresetRange = (
  presetName: string
): { from: Date; to: Date } => {
  const from = businessToday();
  const to = businessToday();
  const first = from.getDate() - from.getDay();

  switch (presetName) {
    case 'today':
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    case 'yesterday':
      from.setDate(from.getDate() - 1);
      from.setHours(0, 0, 0, 0);
      to.setDate(to.getDate() - 1);
      to.setHours(23, 59, 59, 999);
      break;
    case 'last7':
      from.setDate(from.getDate() - 6);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    case 'thisWeek':
      from.setDate(first);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    case 'lastWeek':
      from.setDate(from.getDate() - 7 - from.getDay());
      to.setDate(to.getDate() - to.getDay() - 1);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    case 'thisMonth':
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      break;
    case 'lastMonth':
      // Anchor to the 1st BEFORE shifting the month. `setMonth` on a day the
      // target month doesn't have overflows forward (Mar 31 → "Feb 31" → Mar
      // 3), which produced an inverted range on every month-end date.
      from.setDate(1);
      from.setMonth(from.getMonth() - 1);
      from.setHours(0, 0, 0, 0);
      to.setDate(1);
      to.setDate(0);
      to.setHours(23, 59, 59, 999);
      break;
    default:
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
  }

  return { from, to };
};
