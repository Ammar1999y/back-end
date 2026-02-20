import { memo } from 'react';

import { useShallow } from 'zustand/shallow';

import { AnimatedContent } from '@/components/animated-content';
import { useTabsStore } from '@/components/form/tabs/store';

import { MainTab, TabConfig } from '../../types';
import { BasicInfoSection } from './basic';
import { ContactInfoSection } from './contact-info';
import { FontsSection } from './fonts';
import { ImagesSection } from './images';
import { NavLinksSection } from './nav-links';
import { SocialAccountsSection } from './social-accounts';

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
  { id: 'fonts', label: 'الخطوط' },
  { id: 'socialAccounts', label: 'حسابات التواصل' },
  { id: 'contactInfo', label: 'بيانات التواصل' },
  { id: 'navLinks', label: 'الروابط' },
];

export const TabContent = memo(({ activeTab }: { activeTab: MainTab }) => {
  switch (activeTab) {
    case 'images':
      return <ImagesSection />;
    case 'fonts':
      return <FontsSection />;
    case 'socialAccounts':
      return <SocialAccountsSection />;
    case 'contactInfo':
      return <ContactInfoSection />;
    case 'navLinks':
      return <NavLinksSection />;
    default:
      return <BasicInfoSection />;
  }
});

TabContent.displayName = 'TabContent';
