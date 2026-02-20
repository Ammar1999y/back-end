import type { EntityID } from '.';

/**
 * Font settings embedded in general settings
 * LANGUAGES-TODOS: When adding multi-language support, convert to array structure with languageId
 */
interface SettingsFonts {
  googleFont?: string | null;
  letterSpacing: number;
  lineHeight: number;
  fontSizeMultiplier: number;
}

/**
 * Social account item (e.g., Twitter, Facebook, Instagram)
 */
interface SocialAccountItem {
  id: EntityID;
  key: string; // slug-like identifier
  title: string;
  link: string;
  isActive: boolean;
  order: number;
}

/**
 * Contact info item (e.g., phone, email, address)
 */
interface ContactInfoItem {
  id: EntityID;
  key: string; // slug-like identifier
  title: string;
  link: string;
  isActive: boolean;
  order: number;
}

/**
 * Navigation link item for header/footer
 */
interface NavLinkItem {
  id: EntityID;
  key: string; // slug-like identifier
  title: string;
  link: string; // Can be #section-slug or external URL
  showInHeader: boolean;
  showInFooter: boolean;
  order: number;
}

/**
 * General settings for the application
 */
interface SettingsClient {
  id: EntityID;

  // Basic Info
  siteTitle: string;
  siteDescription?: string | null;
  footerDescription?: string | null;
  copyrightText?: string | null;
  primaryColor?: string | null; // Hex color without alpha (e.g., #02CAAF)

  // Fonts
  fonts?: SettingsFonts | null;

  // Social & Contact
  socialAccounts?: SocialAccountItem[] | null;
  contactInfo?: ContactInfoItem[] | null;
  navLinks?: NavLinkItem[] | null;

  // Timestamps
  createdAt: string;
  updatedAt?: string | null;
}

interface Setting {
  key: string;
  name: string;
  group: string;
  text: string;
  media: string;
}

interface APISettingResponse {
  data: Setting[];
}

export type {
  SettingsClient,
  SettingsFonts,
  SocialAccountItem,
  ContactInfoItem,
  NavLinkItem,
  Setting,
  APISettingResponse,
};
