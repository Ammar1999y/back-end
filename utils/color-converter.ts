import Color from 'color';

type ColorFormat = 'hex' | 'rgb' | 'hsl';

interface HslColor {
  h: number;
  s: number;
  l: number;
  alpha?: number;
}

// Existing functions reimplemented with color library
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  try {
    const color = Color(hex);
    return {
      r: color.red(),
      g: color.green(),
      b: color.blue(),
    };
  } catch {
    return { r: 0, g: 0, b: 0 };
  }
}

export function rgbToHex(r: number, g: number, b: number): string {
  try {
    return Color.rgb(r, g, b).hex();
  } catch {
    return '#000000';
  }
}

export function rgbToHsl(
  r: number,
  g: number,
  b: number
): { h: number; s: number; l: number } {
  try {
    const color = Color.rgb(r, g, b).hsl();
    return {
      h: Math.round(color.hue()),
      s: Math.round(color.saturationl()),
      l: Math.round(color.lightness()),
    };
  } catch {
    return { h: 0, s: 0, l: 0 };
  }
}

export function hslToRgb(
  h: number,
  s: number,
  l: number
): { r: number; g: number; b: number } {
  try {
    const color = Color.hsl(h, s, l);
    return {
      r: Math.round(color.red()),
      g: Math.round(color.green()),
      b: Math.round(color.blue()),
    };
  } catch {
    return { r: 0, g: 0, b: 0 };
  }
}

// New alpha functions
export function hexToRgba(hex: string): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  try {
    const color = Color(hex);
    return {
      r: color.red(),
      g: color.green(),
      b: color.blue(),
      a: color.alpha(),
    };
  } catch {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
}

export function rgbaToHex(r: number, g: number, b: number, a: number): string {
  try {
    // Color library handles alpha in hex if needed, but standard .hex() might not include it if alpha is 1
    // To force alpha or handle it specifically as the original code did:
    const color = Color.rgb(r, g, b).alpha(a);
    // The original code returned 8-digit hex. Color library returns 8 digit if alpha < 1
    // If we strictly want 8 digit hex always or similar behavior:
    const hex = color.hex();
    if (a === 1) return hex;

    // Manually constructing if needed, or just trusting the library.
    // The library returns #RRGGBB or #RRGGBBAA.
    // Let's stick to library behavior which is standard.
    return hex;
  } catch {
    return '#000000';
  }
}

export function rgbaToHsla(
  r: number,
  g: number,
  b: number,
  a: number
): { h: number; s: number; l: number; a: number } {
  try {
    const color = Color.rgb(r, g, b).alpha(a).hsl();
    return {
      h: Math.round(color.hue()),
      s: Math.round(color.saturationl()),
      l: Math.round(color.lightness()),
      a: color.alpha(),
    };
  } catch {
    return { h: 0, s: 0, l: 0, a: 1 };
  }
}

export function hslaToRgba(
  h: number,
  s: number,
  l: number,
  a: number
): { r: number; g: number; b: number; a: number } {
  try {
    const color = Color.hsl(h, s, l).alpha(a);
    return {
      r: Math.round(color.red()),
      g: Math.round(color.green()),
      b: Math.round(color.blue()),
      a: color.alpha(),
    };
  } catch {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
}

// Functions merged from components/theme-customizer/utils/color-converter.ts

export const formatNumber = (num?: number) => {
  if (!num) return '0';
  return num % 1 === 0 ? num : num.toFixed(4);
};

export const formatHsl = (hsl: HslColor, includeAlpha: boolean = true) => {
  const h = formatNumber(hsl.h);
  const s = formatNumber(hsl.s * 100);
  const l = formatNumber(hsl.l * 100);

  return `hsl(${h} ${s}% ${l}%${
    includeAlpha && hsl.alpha !== undefined && hsl.alpha !== 1
      ? ` / ${hsl.alpha}`
      : ''
  })`;
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
          // formatHsl expects s and l to be 0-1 based on how we constructed hsl object above
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
