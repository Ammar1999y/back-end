import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AutosizeTextarea } from '@/components/ui/auto-resize-textarea';
import Label from '@/components/ui/label';

interface FontPreviewProps {
  fontName: string | null | undefined;
  letterSpacing: number;
  lineHeight: number;
  fontSizeMultiplier: number;
  dir?: 'rtl' | 'ltr' | 'auto';
}

const DEFAULT_PREVIEW_TEXT = 'اكتب هنا لمعاينة الخط...';
const BASE_FONT_SIZE = 16; // px

const FontPreview = memo(
  ({
    fontName,
    letterSpacing,
    lineHeight,
    fontSizeMultiplier,
    dir = 'auto',
  }: FontPreviewProps) => {
    const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
    const [fontLoaded, setFontLoaded] = useState(false);
    const loadedFontsRef = useRef<Set<string>>(new Set());

    // Load Google Font dynamically
    useEffect(() => {
      if (!fontName) {
        setFontLoaded(false);
        return;
      }

      // Check if font is already loaded
      if (loadedFontsRef.current.has(fontName)) {
        setFontLoaded(true);
        return;
      }

      setFontLoaded(false);

      // Create link element to load font
      const fontId = `google-font-${fontName.replace(/\s+/g, '-')}`;
      let linkElement = document.getElementById(fontId) as HTMLLinkElement;

      if (!linkElement) {
        linkElement = document.createElement('link');
        linkElement.id = fontId;
        linkElement.rel = 'stylesheet';
        linkElement.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;500;600;700&display=swap`;
        document.head.append(linkElement);
      }

      // Wait for font to load
      const checkFontLoaded = () => {
        if (document.fonts.check(`16px "${fontName}"`)) {
          loadedFontsRef.current.add(fontName);
          setFontLoaded(true);
        } else {
          requestAnimationFrame(checkFontLoaded);
        }
      };

      // Start checking after a small delay to allow the stylesheet to load
      const timeoutId = setTimeout(checkFontLoaded, 100);

      return () => {
        clearTimeout(timeoutId);
      };
    }, [fontName]);

    const handleTextChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setPreviewText(e.target.value);
      },
      []
    );

    const previewStyle = useMemo(
      () => ({
        fontFamily:
          fontName && fontLoaded ? `"${fontName}", sans-serif` : undefined,
        letterSpacing: `${letterSpacing}px`,
        lineHeight: lineHeight,
        fontSize: `${BASE_FONT_SIZE * fontSizeMultiplier}px`,
      }),
      [fontName, fontLoaded, letterSpacing, lineHeight, fontSizeMultiplier]
    );

    return (
      <div className='space-y-2'>
        <Label title='معاينة الخط' />
        <AutosizeTextarea
          value={previewText}
          onChange={handleTextChange}
          placeholder={DEFAULT_PREVIEW_TEXT}
          dir={dir}
          style={previewStyle}
          className='px-4 pb-3 pt-4 transition-all duration-300'
          minRows={4}
          maxRows={10}
        />
        {fontName && !fontLoaded && (
          <p className='text-xs text-muted-foreground'>جاري تحميل الخط...</p>
        )}
      </div>
    );
  }
);

FontPreview.displayName = 'FontPreview';

export { FontPreview };
