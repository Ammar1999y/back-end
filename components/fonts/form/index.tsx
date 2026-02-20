/* eslint-disable unicorn/no-empty-file */
// /* eslint-disable react-hooks/preserve-manual-memoization */
// import type { LanguageFontSettings } from '@/types/font';
// import type { FontSettingsInput } from '@/utils/validation/fonts';

// import { memo, useCallback, useEffect, useMemo } from 'react';

// import { returnNumberOrNull } from '@/utils';
// import { useFormContext, useWatch } from 'react-hook-form';
// import { useShallow } from 'zustand/shallow';

// import { getDefaultLanguageSettings } from '@/utils/store/fonts';

// import { Input } from '@/components/ui/input';
// import Label from '@/components/ui/label';
// import { ErrorMessage } from '@/components/form/error-message';
// // import { LangTabs } from '@/components/form/tabs/lang-tabs';
// import { useTabsStore } from '@/components/form/tabs/store';

// import { FontCombobox } from './font-combobox';
// import { FontPreview } from './font-preview';

// const FontsForm = memo(() => {
//   const { setValue, getValues, control } = useFormContext<FontSettingsInput>();
//   const activeLang = useTabsStore(useShallow((s) => s.activeLang));

//   // Watch the languages array
//   const languages = useWatch({
//     control,
//     name: 'languages',
//   });

//   // Find current language settings index
//   const currentLangIndex = useMemo(() => {
//     if (!activeLang?.id || !languages) return -1;
//     return languages.findIndex((lang) => lang.languageId === activeLang.id);
//   }, [activeLang?.id, languages]);

//   // Get current language settings or create default
//   const currentSettings = useMemo(() => {
//     if (currentLangIndex >= 0 && languages?.[currentLangIndex]) {
//       return languages[currentLangIndex];
//     }
//     if (activeLang?.id) {
//       return getDefaultLanguageSettings(activeLang.id);
//     }
//     return null;
//   }, [currentLangIndex, languages, activeLang?.id]);

//   // Initialize language settings when language changes
//   useEffect(() => {
//     if (!activeLang?.id) return;

//     const currentLanguages = getValues('languages') || [];
//     const existingIndex = currentLanguages.findIndex(
//       (lang) => lang.languageId === activeLang.id
//     );

//     if (existingIndex === -1) {
//       // Add default settings for this language
//       const newSettings = getDefaultLanguageSettings(activeLang.id);
//       setValue('languages', [...currentLanguages, newSettings]);
//     }
//   }, [activeLang?.id, getValues, setValue]);

//   // Update handler for language-specific settings
//   const updateCurrentSettings = useCallback(
//     (updates: Partial<LanguageFontSettings>) => {
//       if (!activeLang?.id) return;

//       const currentLanguages = getValues('languages') || [];
//       const existingIndex = currentLanguages.findIndex(
//         (lang) => lang.languageId === activeLang.id
//       );

//       if (existingIndex !== -1) {
//         const updatedLanguages = [...currentLanguages];
//         updatedLanguages[existingIndex] = {
//           ...updatedLanguages[existingIndex],
//           ...updates,
//         };
//         setValue('languages', updatedLanguages);
//       } else {
//         const newSettings: LanguageFontSettings = {
//           ...getDefaultLanguageSettings(activeLang.id),
//           ...updates,
//         };
//         setValue('languages', [...currentLanguages, newSettings]);
//       }
//     },
//     [activeLang?.id, getValues, setValue]
//   );

//   // Field handlers
//   const handleFontChange = useCallback(
//     (value: string | null) => {
//       updateCurrentSettings({ googleFont: value });
//     },
//     [updateCurrentSettings]
//   );

//   const handleLetterSpacingChange = useCallback(
//     (e: React.ChangeEvent<HTMLInputElement>) => {
//       const value = parseFloat(e.target.value) || 0;
//       updateCurrentSettings({ letterSpacing: value });
//     },
//     [updateCurrentSettings]
//   );

//   const handleLineHeightChange = useCallback(
//     (e: React.ChangeEvent<HTMLInputElement>) => {
//       const value = parseFloat(e.target.value) || 1;
//       updateCurrentSettings({ lineHeight: value });
//     },
//     [updateCurrentSettings]
//   );
//   const handleFontSizeMultiplierChange = useCallback(
//     (e: React.ChangeEvent<HTMLInputElement>) => {
//       const value = parseFloat(e.target.value) || 1;
//       updateCurrentSettings({ fontSizeMultiplier: value });
//     },
//     [updateCurrentSettings]
//   );

//   const nativeLang = activeLang?.english;
//   const inputDir = activeLang?.dir || 'auto';

//   const currentLetterSpacing =
//     returnNumberOrNull(currentSettings?.letterSpacing) || 0;
//   const currentFontSizeMultiplier =
//     returnNumberOrNull(currentSettings?.fontSizeMultiplier) || 1;
//   const currentLineHeight =
//     returnNumberOrNull(currentSettings?.lineHeight) || 1;

//   return (
//     <div className='px-1 space-y-6'>
//       {/* <LangTabs /> */}

//       {currentSettings && (
//         <>
//           {/* Font Selection */}
//           <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
//             <div>
//               <FontCombobox
//                 value={currentSettings.googleFont}
//                 onChange={handleFontChange}
//                 languageName={nativeLang}
//               />
//               <ErrorMessage
//                 path={`languages.${Math.max(currentLangIndex, 0)}.googleFont`}
//               />
//             </div>
//           </div>

//           {/* Spacing & Size Settings */}
//           <div className='grid grid-cols-1 gap-6 sm:grid-cols-3'>
//             {/* Letter Spacing */}
//             <div>
//               <Label
//                 title={`تباعد الأحرف${nativeLang ? ` (${nativeLang})` : ''}`}
//                 htmlFor='letterSpacing'
//               />
//               <Input
//                 id='letterSpacing'
//                 type='number'
//                 step='0.5'
//                 min='-10'
//                 max='50'
//                 value={currentLetterSpacing}
//                 onChange={handleLetterSpacingChange}
//                 dir='ltr'
//                 className='text-center'
//               />
//               <p className='mt-1 text-xs text-muted-foreground'>
//                 القيمة بالبكسل (0 = طبيعي)
//               </p>
//               <ErrorMessage
//                 path={`languages.${Math.max(currentLangIndex, 0)}.letterSpacing`}
//               />
//             </div>

//             {/* Line Height */}
//             <div>
//               <Label
//                 title={`تباعد الأسطر${nativeLang ? ` (${nativeLang})` : ''}`}
//                 htmlFor='lineHeight'
//               />
//               <Input
//                 id='lineHeight'
//                 type='number'
//                 step='0.1'
//                 min='0.5'
//                 max='5'
//                 value={currentLineHeight}
//                 onChange={handleLineHeightChange}
//                 dir='ltr'
//                 className='text-center'
//               />
//               <p className='mt-1 text-xs text-muted-foreground'>
//                 القيمة الافتراضية 1
//               </p>
//               <ErrorMessage
//                 path={`languages.${Math.max(currentLangIndex, 0)}.lineHeight`}
//               />
//             </div>

//             {/* Font Size Multiplier */}
//             <div>
//               <Label
//                 title={`مضاعف حجم الخط${nativeLang ? ` (${nativeLang})` : ''}`}
//                 htmlFor='fontSizeMultiplier'
//               />
//               <Input
//                 id='fontSizeMultiplier'
//                 type='number'
//                 step='0.1'
//                 min='0.5'
//                 max='3'
//                 value={currentFontSizeMultiplier}
//                 onChange={handleFontSizeMultiplierChange}
//                 dir='ltr'
//                 className='text-center'
//               />
//               <p className='mt-1 text-xs text-muted-foreground'>
//                 القيمة الافتراضية 1 (يتم ضربها في حجم الخط الأساسي)
//               </p>
//               <ErrorMessage
//                 path={`languages.${Math.max(currentLangIndex, 0)}.fontSizeMultiplier`}
//               />
//             </div>
//           </div>

//           {/* Font Preview */}
//           <FontPreview
//             fontName={currentSettings.googleFont}
//             letterSpacing={currentLetterSpacing}
//             lineHeight={currentLineHeight}
//             fontSizeMultiplier={currentFontSizeMultiplier}
//             dir={inputDir}
//           />
//         </>
//       )}
//     </div>
//   );
// });

// FontsForm.displayName = 'FontsForm';

// export { FontsForm };
