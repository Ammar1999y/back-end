import Color from 'color';

type ColorFormat = 'hex' | 'rgb' | 'hsl';

interface HslColor {
  h: number;
  s: number;
  l: number;
  alpha?: number;
}

export const formatNumber = (num?: number) => {
  if (!num) return '0';
  return num % 1 === 0 ? num : num.toFixed(4);
};

export const formatHsl = (hsl: HslColor, includeAlpha: boolean = true) => {
  const h = formatNumber(hsl.h);
  const s = formatNumber(hsl.s * 100);
  const l = formatNumber(hsl.l * 100);

  // Check if alpha exists and is not 1 (fully opaque)
  if (includeAlpha && hsl.alpha !== undefined && hsl.alpha !== 1) {
    return `hsl(${h} ${s}% ${l}% / ${hsl.alpha})`;
  }

  return `hsl(${h} ${s}% ${l}%)`;
};

/**
 * Checks if the color value already contains a color function or is in a complete format
 */
const isCompleteColorFormat = (colorValue: string): boolean => {
  const trimmed = colorValue.trim();

  // Check if it's a hex color
  if (trimmed.startsWith('#')) return true;

  // Check if it already contains a color function (hsl, rgb, oklch, hwb, lch, lab, etc.)
  if (trimmed.includes('(')) return true;

  // Check if it's a CSS color keyword
  const cssColorKeywords = [
    'transparent',
    'currentcolor',
    'inherit',
    'initial',
    'unset',
  ];
  if (cssColorKeywords.includes(trimmed.toLowerCase())) return true;

  return false;
};

export const colorFormatter = (
  colorValue: string,
  format: ColorFormat = 'hsl',
  tailwindVersion: '3' | '4' = '3',
  valuesOnly: boolean = false
): string => {
  try {
    // Parse the color using the color library
    const parsedColor = Color(
      isCompleteColorFormat(colorValue) ? colorValue : `hsl(${colorValue})`
    );

    switch (format) {
      case 'hsl': {
        const hslObj = parsedColor.hsl().object();
        const alpha = parsedColor.alpha();

        const hsl: HslColor = {
          h: hslObj.h || 0,
          s: hslObj.s / 100,
          l: hslObj.l / 100,
          alpha: alpha !== 1 ? alpha : undefined,
        };

        const h = formatNumber(hsl.h);
        const s = formatNumber(hsl.s * 100);
        const l = formatNumber(hsl.l * 100);

        // Check if alpha exists and is not 1 (fully opaque)
        const hasAlpha = hsl.alpha !== undefined && hsl.alpha !== 1;
        const alphaValue = hasAlpha ? ` / ${hsl.alpha}` : '';
        const values = `${h} ${s}% ${l}%${alphaValue}`;

        if (valuesOnly) {
          return values;
        }

        if (tailwindVersion === '4') {
          return formatHsl(hsl);
        }
        return values;
      }
      case 'rgb':
        return parsedColor.rgb().string(); // e.g., "rgb(64, 128, 192)"
      case 'hex':
        return parsedColor.hex(); // e.g., "#4080c0"
      default:
        return colorValue;
    }
  } catch (error) {
    console.error(`Failed to convert color: ${colorValue}`, error);
    return colorValue;
  }
};
