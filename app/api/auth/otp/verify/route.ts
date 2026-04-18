import { toNextHandler } from '@/lib/http/adapters/next';

import * as handlers from './handler';

export const POST = toNextHandler(handlers.POST);
