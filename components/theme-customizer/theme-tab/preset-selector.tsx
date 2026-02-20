import { memo, useCallback, useMemo } from 'react';

import { Dices as _Dices } from 'lucide-react';
import { useShallow } from 'zustand/shallow';

import { Button } from '@/components/ui/button';
import Label from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { defaultLightThemeStyles } from '../config/theme';
import { useEditorStore } from '../store/editor-store';
import { useThemePresetStore } from '../store/theme-preset-store';
import { PresetColorIndicator } from './preset-color-indicator';

// Memoize lucide icon
const Dices = memo(_Dices);
Dices.displayName = 'Dices';

// Priority order for themes
const PRIORITY_THEMES = [
  'blue',
  'green',
  'red',
  'rose',
  'orange',
  'yellow',
  'violet',
  'amber',
  'purple',
  'teal',
];

const PresetSelector = memo(() => {
  const themeState = useEditorStore(useShallow((s) => s.themeState));
  const presets = useThemePresetStore((store) => store.getAllPresets());

  const sortedPresetNames = useMemo(() => {
    const presetNames = ['default', ...Object.keys(presets)];

    const defaultTheme = presetNames.filter((name) => name === 'default');
    const priorityOrderedThemes = PRIORITY_THEMES.filter((name) =>
      presetNames.includes(name)
    );
    const otherThemes = presetNames
      .filter((name) => name !== 'default' && !PRIORITY_THEMES.includes(name))
      .sort((a, b) => {
        const labelA = presets[a]?.label || a;
        const labelB = presets[b]?.label || b;
        return labelA.localeCompare(labelB);
      });

    return [...defaultTheme, ...priorityOrderedThemes, ...otherThemes];
  }, [presets]);

  const handleRandomPreset = useCallback(() => {
    const randomPresetName =
      sortedPresetNames[Math.floor(Math.random() * sortedPresetNames.length)];
    useEditorStore.getState().applyThemePreset(randomPresetName);
  }, [sortedPresetNames]);

  const handlePresetChange = useCallback((value: string) => {
    useEditorStore.getState().applyThemePreset(value);
  }, []);

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between'>
        <Label
          className='mb-0 font-medium'
          htmlFor='theme-selector'
          title='تنسيقات الألوان الجاهزة'
        />
        <Button
          variant='outline'
          size='none'
          onClick={handleRandomPreset}
          className='cursor-pointer px-3 py-1'
        >
          <Dices className='size-4' />
          <span>عشوائي</span>
        </Button>
      </div>

      <Select value={themeState.preset} onValueChange={handlePresetChange}>
        <SelectTrigger className='w-full cursor-pointer' id='theme-selector'>
          <SelectValue placeholder='اختر تنسيق الألوان' />
        </SelectTrigger>
        <SelectContent className='max-h-[60vh]'>
          <div className='p-2'>
            {sortedPresetNames.map((presetName) => {
              const preset = presets[presetName];
              if (!preset && presetName !== 'default') return null;

              const themeColors =
                presetName === 'default'
                  ? defaultLightThemeStyles
                  : preset!.styles.light;

              return (
                <SelectItem
                  key={presetName}
                  value={presetName}
                  className='cursor-pointer'
                >
                  <div className='flex items-center space-x-2'>
                    <PresetColorIndicator
                      presetName={presetName}
                      themeColors={themeColors}
                    />
                    <span>{preset?.label || presetName}</span>
                  </div>
                </SelectItem>
              );
            })}
          </div>
        </SelectContent>
      </Select>
    </div>
  );
});
PresetSelector.displayName = 'PresetSelector';
export { PresetSelector };
