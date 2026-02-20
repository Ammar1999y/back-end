export type { SettingsClient as Settings } from '@/types/settings';

export type MainTab =
  | 'basic'
  | 'images'
  | 'fonts'
  | 'socialAccounts'
  | 'contactInfo'
  | 'navLinks';

export interface TabConfig {
  id: string;
  label: string;
}
