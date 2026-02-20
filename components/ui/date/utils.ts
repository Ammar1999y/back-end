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

export const tableFormatDate = (date: string | null): string => {
  if (!date) return '-';
  try {
    return new Date(date).toISOString().slice(0, 10);
  } catch {
    return '-';
  }
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

export const getPresetRange = (
  presetName: string
): { from: Date; to: Date } => {
  const from = new Date();
  const to = new Date();
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
      from.setMonth(from.getMonth() - 1);
      from.setDate(1);
      from.setHours(0, 0, 0, 0);
      to.setDate(0);
      to.setHours(23, 59, 59, 999);
      break;
    default:
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
  }

  return { from, to };
};
