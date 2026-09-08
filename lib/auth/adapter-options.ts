import type { DrizzleAdapterConfig } from 'better-auth/adapters/drizzle';

import * as schema from '@/db/schema';

export const authAdapterOptions = {
  provider: 'pg',
  schema,
} satisfies DrizzleAdapterConfig;
