export interface Preset {
  name: string;
  label: string;
}

export const PRESETS: Preset[] = [
  { name: 'today', label: 'اليوم' },
  { name: 'yesterday', label: 'امس' },
  { name: 'last7', label: 'أخر 7 أيام' },
  { name: 'thisWeek', label: 'هذا الأسبوع' },
  { name: 'lastWeek', label: 'الاسبوع الماضي' },
  { name: 'thisMonth', label: 'هذا الشهر' },
  { name: 'lastMonth', label: 'الشهر الماضي' },
];
