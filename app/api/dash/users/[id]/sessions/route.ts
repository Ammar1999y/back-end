import { toNextHandler } from '@/lib/http/adapters/next';

import * as handlers from './handler';

export const GET = toNextHandler(handlers.GET, { preAuthIpLimit: true });
export const DELETE = toNextHandler(handlers.DELETE, { preAuthIpLimit: true });
