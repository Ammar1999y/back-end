/** biome-ignore-all lint/suspicious/noGlobalIsNan: true */
'use client';

import * as React from 'react';

import { ImageUpscale } from 'lucide-react';
import { useEditorRef, useElement } from 'platejs/react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function MediaResizePopover() {
  const editor = useEditorRef();
  const element = useElement();

  const [isOpen, setIsOpen] = React.useState(false);
  const [percentageWidth, setPercentageWidth] = React.useState('');
  const [pixelWidth, setPixelWidth] = React.useState('');
  const [pixelHeight, setPixelHeight] = React.useState('');
  const [aspectRatio, setAspectRatio] = React.useState(1);

  // Load current dimensions when dialog opens
  React.useEffect(() => {
    if (isOpen) {
      const currentWidth = element.width || '100%';

      if (typeof currentWidth === 'string' && currentWidth.includes('%')) {
        // Current width is percentage
        setPercentageWidth(currentWidth.replace('%', ''));
        setPixelWidth('');
        setPixelHeight('');
      } else {
        // Current width is pixels or need to calculate
        setPercentageWidth('');

        // Get actual image dimensions from DOM
        const img = document.querySelector(
          `[data-slate-node="element"] img[src="${element.url}"]`
        ) as HTMLImageElement;

        if (img) {
          const width = img.offsetWidth;
          const height = img.offsetHeight;
          const ratio = width / height;

          setAspectRatio(ratio);
          setPixelWidth(width.toString());
          setPixelHeight(height.toString());
        }
      }
    }
  }, [isOpen, element]);

  const handlePercentageChange = (value: string) => {
    setPercentageWidth(value);
    setPixelWidth('');
    setPixelHeight('');
  };

  const handlePixelWidthChange = (value: string) => {
    setPixelWidth(value);
    setPercentageWidth('');

    if (value && !isNaN(Number(value)) && aspectRatio) {
      const newHeight = Math.round(Number(value) / aspectRatio);
      setPixelHeight(newHeight.toString());
    }
  };

  const handlePixelHeightChange = (value: string) => {
    setPixelHeight(value);
    setPercentageWidth('');

    if (value && !isNaN(Number(value)) && aspectRatio) {
      const newWidth = Math.round(Number(value) * aspectRatio);
      setPixelWidth(newWidth.toString());
    }
  };

  const applyResize = () => {
    let newWidth: string | number = '100%';

    if (percentageWidth && !isNaN(Number(percentageWidth))) {
      newWidth = `${percentageWidth}%`;
    } else if (pixelWidth && !isNaN(Number(pixelWidth))) {
      newWidth = Number(pixelWidth);
    }

    editor.tf.setNodes(
      { width: newWidth },
      { at: editor.api.findPath(element) }
    );

    setIsOpen(false);
    editor.tf.focus();
  };

  return (
    <Popover onOpenChange={setIsOpen} open={isOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button size='sm' variant='ghost'>
              <ImageUpscale />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>تعديل الأبعاد</TooltipContent>
      </Tooltip>

      <PopoverContent align='start' className='w-80'>
        <div className='space-y-4'>
          {/* Percentage Width */}
          <div className='space-y-2'>
            <label className='text-sm font-medium' htmlFor='percentageWidth'>
              العرض (نسبة مئوية)
            </label>
            <input
              className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
              id='percentageWidth'
              onChange={(e) => handlePercentageChange(e.target.value)}
              placeholder='100'
              type='number'
              value={percentageWidth}
            />

            {/* Quick presets */}
            <div className='flex gap-2'>
              {['100', '75', '50', '25'].map((preset) => (
                <Button
                  className='flex-1'
                  key={preset}
                  onClick={() => handlePercentageChange(preset)}
                  size='sm'
                  variant='outline'
                >
                  {preset}%
                </Button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Pixel Width */}
          <div className='space-y-2'>
            <label className='text-sm font-medium' htmlFor='pixelWidth'>
              العرض (بكسل)
            </label>
            <input
              className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
              id='pixelWidth'
              onChange={(e) => handlePixelWidthChange(e.target.value)}
              placeholder='500'
              type='number'
              value={pixelWidth}
            />
          </div>

          {/* Pixel Height */}
          <div className='space-y-2'>
            <label className='text-sm font-medium' htmlFor='pixelHeight'>
              الطول (بكسل)
            </label>
            <input
              className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
              id='pixelHeight'
              onChange={(e) => handlePixelHeightChange(e.target.value)}
              placeholder='281'
              type='number'
              value={pixelHeight}
            />
          </div>

          {/* Apply Button */}
          <Button className='w-full' onClick={applyResize}>
            تطبيق
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
