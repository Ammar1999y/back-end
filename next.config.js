const { PUBLIC_URL } = require('./lib/env');

// TODO: clear the unuse
const isDev = process.env.NODE_ENV !== 'production';
const CSP = `
  base-uri 'self';
  default-src 'self';
  script-src 'self' 'sha256-nne+twLvxGzokkKtrC/+Z9Mdq4l8OjukUCknsajUZSs=' https://challenges.cloudflare.com/turnstile/${isDev ? " 'unsafe-eval' 'unsafe-inline'" : ''};
  style-src 'self' 'unsafe-inline';
  font-src 'self';
  connect-src 'self';
  frame-src 'self' https://challenges.cloudflare.com/;
  worker-src 'self' blob:;
  img-src 'self' data: blob:;
  media-src 'self';
  object-src 'none';
  form-action 'none';
  frame-ancestors 'none';
  upgrade-insecure-requests;
`;
// TODO: try to add this in production
/* 
Content-Security-Policy: require-trusted-types-for 'script';
                         trusted-types default;
*/

// TODO: activate the caches in production
const headers = isDev
  ? []
  : [
      {
        // source: "/((?!_next/|api/|.*.(?:css|js|mjs|map|json|txt|xml|ico|png|jpg|jpeg|webp|gif|svg|mp4|webm|woff2?|ttf|otf|woff|eot|pdf)$).*)",
        source: '/(.*?)',
        // has: [{ type: "header", key: "accept", value: ".*text/html.*" }],
        locale: false,
        headers: [
          {
            key: 'Content-Security-Policy',
            value: CSP.replaceAll(/\s{2,}/g, ' ').trim(),
          },
          {
            key: 'X-Frame-Options',
            value: `DENY`,
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin',
          },
          {
            key: 'Cross-Origin-Resource-Policy', // dont use it with PDF files
            value: `same-origin`,
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless', // try to convert it to require-corp, and force the resource owner to set the CORP as cross-origin, or CORS to the the domin of the front-end
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Strict-Transport-Security',
            value: `max-age=63072000; includeSubDomains; preload`,
          },
          {
            key: 'Access-Control-Allow-Origin',
            value: PUBLIC_URL /* الغيه واستخدمة فقط مع APIs و الخطوط والصور */,
          },
          // إذا صارت الواجهة على origin مختلف (أو تحولنا لإطار آخر يتحكم بـ CORS يدوياً)،
          // يجب السماح للمتصفح بقراءة رؤوس rate limit لتظهر في الـ UI.
          // {
          //   key: 'Access-Control-Expose-Headers',
          //   value: 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining',
          // },
          {
            key: 'X-XSS-Protection',
            value: '0', // لتعطيل الفلتر القديم الذي به مشاكل
          },
          {
            key: 'Origin-Agent-Cluster',
            value: '?1', // لعزل الأصول
          },
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'off', // للخصوصية
          },
          {
            key: 'X-Permitted-Cross-Domain-Policies',
            value: 'none', // لمنتجات Adobe
          },
        ],
      },
      // {
      //   source: '/(pwa|js|images|styles|fonts)/(.*?)',
      //   headers: [
      //     {
      //       key: 'Cache-Control',
      //       value: 'public, max-age=604800, immutable', // 1 week, change it depend on how often you update the files
      //     },
      //   ],
      // },
      {
        source: '/public/(.*?)',
        headers: [
          // {
          //   key: 'Cache-Control',
          //   value: 'public, max-age=604800, immutable', // 1 week, change it depend on how often you update the files
          // },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
      {
        source:
          '/(manifest.json|og.png|favicon.ico|robots.txt|sitemap.xml|.well-known(?:/.*)?)', // the (?:/.*)? should use for folders
        headers: [
          // {
          //   key: 'Cache-Control',
          //   value: 'public, max-age=604800, immutable', // 1 week, change it depend on how often you update the files
          // },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: `cross-origin`,
          },
        ],
      },
      {
        source:
          '/(manifest.json|og.png|favicon.ico|robots.txt|sitemap.xml|.well-known(?:/.*)?)', // the (?:/.*)? should use for folders
        locale: false,
        headers: [
          // {
          //   key: 'Cache-Control',
          //   value: 'public, max-age=604800, immutable', // 1 week, change it depend on how often you update the files
          // },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: `cross-origin`,
          },
        ],
      },
      {
        source: '/_next/static/(.*?)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  reactCompiler: true,
  poweredByHeader: false,
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
        port: '',
        search: '',
      },
      {
        protocol: 'http',
        hostname: '**',
        port: '',
        search: '',
      },
    ],
  },
  async headers() {
    return headers;
  },
  logging: {
    fetches: {
      fullUrl: true,
    },
  },
  experimental: {
    scrollRestoration: false,
  },
};
module.exports = nextConfig;
