import { memo } from 'react';

import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';

interface PresetButtonProps {
  preset: string;
  label: string;
  isSelected: boolean;
  onSelect: (preset: string) => void;
}

export const PresetButton = memo<PresetButtonProps>(
  ({ preset, label, isSelected, onSelect }) => (
    <Button
      className={cn('py-1.5 font-normal', isSelected && 'pointer-events-none')}
      variant='ghost'
      disabled={isSelected}
      onClick={() => onSelect(preset)}
    >
      <span>{label}</span>
      <span className={cn('opacity-0', isSelected && 'opacity-70')}>
        <CheckIcon width={18} height={18} />
      </span>
    </Button>
  )
);

PresetButton.displayName = 'PresetButton';
