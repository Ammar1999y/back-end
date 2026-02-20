import { JSDOM } from 'jsdom';
import { optimize } from 'svgo';

import { CustomError } from '../error-class';
import { svgoConfig } from './config';
import { sanitizeSvg } from './svg-optimizer';

export function svgOptimizerServer({ data }: { data: string }) {
  const optimized = optimize(data, svgoConfig);

  if (!optimized.data)
    throw new CustomError(
      'حدثت مشكله اثناء ضغط الايقونه، اعد المحاولة او قم برفع الايقونه مره اخرى'
    );

  return optimized.data;
}

/**
 * Server-side SVG sanitizer using jsdom
 * Only use in API routes or server components
 */
export function sanitizeSvgServer(
  svgContent: string,
  { convertColor = false } = {}
) {
  // runScripts: "outside-only" gives access to DOMParser/XMLSerializer
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  return sanitizeSvg(svgContent, {
    convertColor,
    parser: new dom.window.DOMParser(),
    serializer: new dom.window.XMLSerializer(),
  });
}
