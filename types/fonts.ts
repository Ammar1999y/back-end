import { EntityID } from '.';

/**
 * Font file for custom uploaded fonts (future use)
 */
export interface FontFile {
  id?: EntityID;
  name: string;
  url: string;
  format?: 'woff2' | 'woff' | 'ttf' | 'otf';
}

/**
 * Font settings for a specific language
 */
export interface LanguageFontSettings {
  languageId: EntityID;
  googleFont?: string | null;
  customFontFiles?: FontFile[] | null;
  letterSpacing: number; // in px (0 = normal)
  lineHeight: number; // multiplier (1 = 100%)
  fontSizeMultiplier: number; // multiplier (1 = 100%)
}

/**
 * Global font settings containing all language configurations
 */
export interface FontSettings {
  id: EntityID;
  languages: LanguageFontSettings[];
  createdAt: string;
  updatedAt?: string;
}

/**
 * Client-side font settings type
 */
export type FontSettingsClient = FontSettings;
