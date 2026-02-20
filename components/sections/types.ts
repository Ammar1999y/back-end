export type { SectionClient as Section } from '@/types/sections';

export type MainTab = 'basic' | 'images' | 'items';

export interface TabConfig {
  id: string;
  label: string;
}
