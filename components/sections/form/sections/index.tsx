import { memo } from 'react';

import { useShallow } from 'zustand/shallow';

import { AnimatedContent } from '@/components/animated-content';
import { useTabsStore } from '@/components/form/tabs/store';

import { MainTab, TabConfig } from '../../types';
import { BasicInfoSection } from './basic';
import { ImagesSection } from './images';
import { ItemsSection } from './items';

export const FormContent = memo(() => {
  const activeMainTab = useTabsStore(useShallow((s) => s.activeMainTab));

  return (
    <AnimatedContent keyValue={activeMainTab || ''}>
      <TabContent activeTab={activeMainTab as MainTab} />
    </AnimatedContent>
  );
});

FormContent.displayName = 'FormContent';

export const MAIN_TABS: TabConfig[] = [
  { id: 'basic', label: 'المعلومات الأساسية' },
  { id: 'images', label: 'الصور' },
  { id: 'items', label: 'العناصر' },
];

export const TabContent = memo(({ activeTab }: { activeTab: MainTab }) => {
  switch (activeTab) {
    case 'images':
      return <ImagesSection />;
    case 'items':
      return <ItemsSection />;
    default:
      return <BasicInfoSection />;
  }
});

TabContent.displayName = 'TabContent';
