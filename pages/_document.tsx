import { Head, Html, Main, NextScript } from 'next/document';

const MyDocument = () => {
  return (
    <Html
      lang={'ar'}
      dir={'rtl'}
      suppressHydrationWarning
      data-scroll-behavior='smooth'
    >
      <Head />
      {/* <Head>
        <script
          dangerouslySetInnerHTML={{
            __html: `history.scrollRestoration = "manual";window.history.scrollRestoration = "manual"`,
          }}
        />
      </Head> */}
      {/* <Head>
        <script
          crossOrigin='anonymous'
          src='//unpkg.com/react-scan/dist/auto.global.js'
        />
      </Head> */}
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
};

export default MyDocument;
