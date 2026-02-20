import { optimize } from 'svgo/browser';

import { CustomError } from '../../utils/error-class';
import { svgoConfig } from './config';

export async function svgOptimizerClient({ data }: { data: string }) {
  const optimized = optimize(data, svgoConfig);

  if (!optimized.data)
    throw new CustomError(
      'حدثت مشكله اثناء ضغط الايقونه، اعد المحاولة او قم برفع الايقونه مره اخرى'
    );

  return optimized.data;
}
