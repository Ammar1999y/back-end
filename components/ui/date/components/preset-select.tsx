import { memo } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { PRESETS } from '../constants';

interface PresetSelectProps {
  selectedPreset: string | undefined;
  onPresetSelect: (preset: string) => void;
}

export const PresetSelect = memo<PresetSelectProps>(
  ({ selectedPreset, onPresetSelect }) => (
    <Select defaultValue={selectedPreset} onValueChange={onPresetSelect}>
      <SelectTrigger className='mx-auto mb-2 mt-3 !h-9 w-44'>
        <SelectValue placeholder='اختيار سريع' />
      </SelectTrigger>
      <SelectContent>
        {PRESETS.map((preset) => (
          <SelectItem key={preset.name} value={preset.name}>
            {preset.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
);

PresetSelect.displayName = 'PresetSelect';
