import React from 'react';

export type TColor = {
  isBrightColor: boolean;
  value: string;
};

export const CUSTOM_COLORS_STORAGE_KEY = 'plate-editor-custom-colors';

export const DEFAULT_COLORS = [
  {
    isBrightColor: false,
    value: '#000000',
  },
  {
    isBrightColor: false,
    value: '#434343',
  },
  {
    isBrightColor: false,
    value: '#666666',
  },
  {
    isBrightColor: false,
    value: '#999999',
  },
  {
    isBrightColor: false,
    value: '#B7B7B7',
  },
  {
    isBrightColor: false,
    value: '#CCCCCC',
  },
  {
    isBrightColor: false,
    value: '#D9D9D9',
  },
  {
    isBrightColor: false,
    value: '#EFEFEF',
  },
  {
    isBrightColor: false,
    value: '#F3F3F3',
  },
  {
    isBrightColor: true,
    value: '#FFFFFF',
  },
  {
    isBrightColor: false,
    value: '#980000',
  },
  {
    isBrightColor: false,
    value: '#FF0000',
  },
  {
    isBrightColor: false,
    value: '#FF9900',
  },
  {
    isBrightColor: false,
    value: '#FFFF00',
  },
  {
    isBrightColor: false,
    value: '#00FF00',
  },
  {
    isBrightColor: false,
    value: '#00FFFF',
  },
  {
    isBrightColor: false,
    value: '#4A86E8',
  },
  {
    isBrightColor: false,
    value: '#0000FF',
  },
  {
    isBrightColor: false,
    value: '#9900FF',
  },
  {
    isBrightColor: false,
    value: '#FF00FF',
  },
  {
    isBrightColor: false,
    value: '#E6B8AF',
  },
  {
    isBrightColor: false,
    value: '#F4CCCC',
  },
  {
    isBrightColor: false,
    value: '#FCE5CD',
  },
  {
    isBrightColor: false,
    value: '#FFF2CC',
  },
  {
    isBrightColor: false,
    value: '#D9EAD3',
  },
  {
    isBrightColor: false,
    value: '#D0E0E3',
  },
  {
    isBrightColor: false,
    value: '#C9DAF8',
  },
  {
    isBrightColor: false,
    value: '#CFE2F3',
  },
  {
    isBrightColor: false,
    value: '#D9D2E9',
  },
  {
    isBrightColor: false,
    value: '#EAD1DC',
  },
  {
    isBrightColor: false,
    value: '#DD7E6B',
  },
  {
    isBrightColor: false,
    value: '#EA9999',
  },
  {
    isBrightColor: false,
    value: '#F9CB9C',
  },
  {
    isBrightColor: false,
    value: '#FFE599',
  },
  {
    isBrightColor: false,
    value: '#B6D7A8',
  },
  {
    isBrightColor: false,
    value: '#A2C4C9',
  },
  {
    isBrightColor: false,
    value: '#A4C2F4',
  },
  {
    isBrightColor: false,
    value: '#9FC5E8',
  },
  {
    isBrightColor: false,
    value: '#B4A7D6',
  },
  {
    isBrightColor: false,
    value: '#D5A6BD',
  },
  {
    isBrightColor: false,
    value: '#CC4125',
  },
  {
    isBrightColor: false,
    value: '#E06666',
  },
  {
    isBrightColor: false,
    value: '#F6B26B',
  },
  {
    isBrightColor: false,
    value: '#FFD966',
  },
  {
    isBrightColor: false,
    value: '#93C47D',
  },
  {
    isBrightColor: false,
    value: '#76A5AF',
  },
  {
    isBrightColor: false,
    value: '#6D9EEB',
  },
  {
    isBrightColor: false,
    value: '#6FA8DC',
  },
  {
    isBrightColor: false,
    value: '#8E7CC3',
  },
  {
    isBrightColor: false,
    value: '#C27BA0',
  },
  {
    isBrightColor: false,
    value: '#A61C00',
  },
  {
    isBrightColor: false,
    value: '#CC0000',
  },
  {
    isBrightColor: false,
    value: '#E69138',
  },
  {
    isBrightColor: false,
    value: '#F1C232',
  },
  {
    isBrightColor: false,
    value: '#6AA84F',
  },
  {
    isBrightColor: false,
    value: '#45818E',
  },
  {
    isBrightColor: false,
    value: '#3C78D8',
  },
  {
    isBrightColor: false,
    value: '#3D85C6',
  },
  {
    isBrightColor: false,
    value: '#674EA7',
  },
  {
    isBrightColor: false,
    value: '#A64D79',
  },
  {
    isBrightColor: false,
    value: '#85200C',
  },
  {
    isBrightColor: false,
    value: '#990000',
  },
  {
    isBrightColor: false,
    value: '#B45F06',
  },
  {
    isBrightColor: false,
    value: '#BF9000',
  },
  {
    isBrightColor: false,
    value: '#38761D',
  },
  {
    isBrightColor: false,
    value: '#134F5C',
  },
  {
    isBrightColor: false,
    value: '#1155CC',
  },
  {
    isBrightColor: false,
    value: '#0B5394',
  },
  {
    isBrightColor: false,
    value: '#351C75',
  },
  {
    isBrightColor: false,
    value: '#741B47',
  },
  {
    isBrightColor: false,
    value: '#5B0F00',
  },
  {
    isBrightColor: false,
    value: '#660000',
  },
  {
    isBrightColor: false,
    value: '#783F04',
  },
  {
    isBrightColor: false,
    value: '#7F6000',
  },
  {
    isBrightColor: false,
    value: '#274E12',
  },
  {
    isBrightColor: false,
    value: '#0D343D',
  },
  {
    isBrightColor: false,
    value: '#1B4487',
  },
  {
    isBrightColor: false,
    value: '#083763',
  },
  {
    isBrightColor: false,
    value: '#1F124D',
  },
  {
    isBrightColor: false,
    value: '#4C1130',
  },
];

// Hook to manage custom colors in localStorage
export function useCustomColors() {
  const [customColors, setCustomColors] = React.useState<TColor[]>([]);

  React.useEffect(() => {
    const stored = localStorage.getItem(CUSTOM_COLORS_STORAGE_KEY);
    if (stored) {
      try {
        setCustomColors(JSON.parse(stored));
      } catch {
        setCustomColors([]);
      }
    }
  }, []);

  const addCustomColor = React.useCallback((color: string) => {
    setCustomColors((prev) => {
      // Check if color already exists
      if (prev.some((c) => c.value.toUpperCase() === color.toUpperCase())) {
        return prev;
      }
      const newColors = [
        { isBrightColor: false, value: color.toUpperCase() },
        ...prev,
      ].slice(0, 10); // Limit to 10 custom colors
      localStorage.setItem(
        CUSTOM_COLORS_STORAGE_KEY,
        JSON.stringify(newColors)
      );
      return newColors;
    });
  }, []);

  const clearCustomColors = React.useCallback(() => {
    setCustomColors([]);
    localStorage.removeItem(CUSTOM_COLORS_STORAGE_KEY);
  }, []);

  return { customColors, addCustomColor, clearCustomColors };
}
