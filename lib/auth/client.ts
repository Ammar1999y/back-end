import type { auth } from '../auth';

import { inferAdditionalFields } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields<typeof auth>({
      user: {
        captcha: {
          type: 'string',
        },
      },
    }),
  ],
});

export type Session = typeof authClient.$Infer.Session;
