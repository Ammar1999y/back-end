import { JSDOM } from 'jsdom';
import { optimize } from 'svgo';

import { HTTP_STATUS } from '../../utils/api-messages';
import { CustomError } from '../../utils/error-class';
import { svgoConfig } from './config';
import { sanitizeSvg } from './svg-optimizer';

const OPTIMIZE_FAILED =
  'حدثت مشكله اثناء ضغط الايقونه، اعد المحاولة او قم برفع الايقونه مره اخرى';

export function svgOptimizerServer({ data }: { data: string }) {
  let optimized;
  try {
    optimized = optimize(data, svgoConfig);
  } catch {
    throw new CustomError(OPTIMIZE_FAILED, HTTP_STATUS.UNPROCESSABLE);
  }

  if (!optimized.data)
    throw new CustomError(OPTIMIZE_FAILED, HTTP_STATUS.UNPROCESSABLE);

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
