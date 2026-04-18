import { Redis } from '@upstash/redis';

// Shared Redis client for rate-limit storage (auth + API routes).
// When moving off Vercel/Upstash, swap this module to point at the new backend
// and keep the public API (auth-storage, rateLimit) unchanged.
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});
