import { toNextHandler } from '@/lib/http/adapters/next';

import * as handlers from './handler';

export const GET = toNextHandler(handlers.GET);
export const PUT = toNextHandler(handlers.PUT);
export const DELETE = toNextHandler(handlers.DELETE);
