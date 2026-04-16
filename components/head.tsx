import Head from 'next/head';
import { memo } from 'react';

import { primaryColor } from '@/constants';
import { PUBLIC_URL } from '@/lib/env';

// TODO
const metadata = {
  appCapable: 'yes',
  themeColor: primaryColor,
  appleTouchIcon: '/public/images/logo180.png',
  mobileWebAppCapable: 'yes',
  og: {
    height: '630',
    width: '1200',
    imageType: 'image/png',
    url: `${PUBLIC_URL}/og.png`,
    type: 'website',
  },
  twitter: {
    type: 'summary_large_image',
    site: null,
  },
  manifest: true,
};
const HeadComponent = memo(
  ({
    title,
    description,
    pathname,
    currentLocale,
  }: {
    title: {
      default: string;
      template?: string;
    };
    description: string;
    pathname: string;
    currentLocale: string;
  }) => {
    const fullTitle =
      title && title.default
        ? (title?.template ? `${title.template} | ` : '') + title.default
        : '';

    const normalizePath = (p: string) => {
      if (!p || p === '/') return '';
      return (p.startsWith('/') ? p : `/${p}`).replace(/\/+$/, '');
    };

    const normalizedPath = normalizePath(pathname);

    const fullUrl = `${PUBLIC_URL}${normalizedPath}`;

    return (
      <Head>
        <title>{fullTitle}</title>
        <meta name='description' content={description} />
        <meta name='application-name' content={title.default} />
        <meta name='apple-mobile-web-app-title' content={title.default} />
        <meta property='og:title' content={fullTitle} />
        <meta property='og:site_name' content={title.default} />
        <meta property='og:description' content={description} />
        <meta name='twitter:title' content={fullTitle} />
        <meta name='twitter:description' content={description} />
        <meta property='og:url' content={fullUrl} />
        <meta property='og:locale' content={currentLocale} />
      </Head>
    );
  }
);

HeadComponent.displayName = 'HeadComponent';

export default HeadComponent;
const StaticHead = memo(() => {
  return (
    <Head>
      <meta
        name='viewport'
        content='width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=yes'
      />
      {/* 🟥🟥 The safe zone of the maskable is a central circle of 409×409. You can use maskable.app to check your icon */}
      {metadata.manifest && <link rel='manifest' href='/manifest.json' />}
      <link rel='icon' href='/favicon.ico' sizes='32x32' />
      {!!metadata.appleTouchIcon && (
        <link rel='apple-touch-icon' href={metadata.appleTouchIcon} />
      )}

      <meta
        name='mobile-web-app-capable'
        content={metadata.mobileWebAppCapable}
      />
      <meta
        name='apple-mobile-web-app-capable'
        content={metadata.mobileWebAppCapable}
      />

      <meta name='msapplication-tap-highlight' content='no' />
      <meta name='msapplication-TileColor' content={metadata.themeColor} />
      <meta name='HandheldFriendly' content='true' />
      <meta name='robots' content='index, follow' />
      <meta name='revisit-after' content='7 days' />
      <meta name='format-detection' content='telephone=no' />

      {/* https://medium.com/appscope/changing-the-ios-status-bar-of-your-progressive-web-app-9fc8fbe8e6ab */}
      <meta name='apple-mobile-web-app-status-bar-style' content='default' />
      <meta name='theme-color' content={metadata.themeColor} />

      <meta property='og:type' content={metadata.og.type} />
      <meta property='og:image:type' content={metadata.og.imageType} />
      <meta property='og:image:width' content={metadata.og.width} />
      <meta property='og:image:height' content={metadata.og.height} />
      <meta property='og:image' content={metadata.og.url} />

      <meta name='twitter:image:type' content={metadata.og.imageType} />
      <meta name='twitter:image:width' content={metadata.og.width} />
      <meta name='twitter:image:height' content={metadata.og.height} />
      <meta name='twitter:image' content={metadata.og.url} />
      <meta name='twitter:card' content={metadata.twitter.type} />
      {!!metadata.twitter.site && (
        <>
          <meta name='twitter:site' content={metadata.twitter.site} />
          <meta name='twitter:creator' content={metadata.twitter.site} />
        </>
      )}
    </Head>
  );
});

StaticHead.displayName = 'StaticHead';

export { StaticHead };
