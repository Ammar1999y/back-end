import { memo } from 'react';

const PresetColorIndicator = memo(
  ({
    presetName,
    themeColors,
  }: {
    presetName: string;
    themeColors: Record<string, string>;
  }) => {
    const colorKeys = ['primary', 'secondary', 'accent', 'muted'] as const;

    return (
      <div className='flex space-x-1'>
        {colorKeys.map((colorKey) => (
          <div
            key={colorKey}
            className='h-3 w-3 rounded-full border border-border/20'
            style={{
              backgroundColor:
                presetName === 'default'
                  ? `hsl(${themeColors[colorKey]})`
                  : themeColors[colorKey],
            }}
          />
        ))}
      </div>
    );
  }
);
PresetColorIndicator.displayName = 'PresetColorIndicator';

export { PresetColorIndicator };
