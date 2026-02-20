import { memo } from 'react';

import { PRESETS } from '../constants';
import { PresetButton } from './preset-button';

interface PresetListProps {
  selectedPreset: string | undefined;
  onPresetSelect: (preset: string) => void;
}

export const PresetList = memo<PresetListProps>(
  ({ selectedPreset, onPresetSelect }) => (
    <div className='flex w-full flex-col items-start space-y-1'>
      {PRESETS.map((preset) => (
        <PresetButton
          key={preset.name}
          preset={preset.name}
          label={preset.label}
          isSelected={selectedPreset === preset.name}
          onSelect={onPresetSelect}
        />
      ))}
    </div>
  )
);

PresetList.displayName = 'PresetList';
