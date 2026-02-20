// import { memo, useEffect } from 'react';

// const DataScrollLocked = memo(() => {
//   useEffect(() => {
//     async function importLenis() {
//       const lenisModule = await import('lenis');
//       const Lenis = lenisModule.default;
//       const lenis = new Lenis();
//       async function raf(time: number) {
//         lenis.raf(time);
//         requestAnimationFrame(raf);
//       }
//       requestAnimationFrame(raf);
//     }
//     importLenis();
//   }, []);

//   return null;
// });

// DataScrollLocked.displayName = 'DataScrollLocked';

// export default DataScrollLocked;

import type { LenisRef } from 'lenis/react';

import { memo, useEffect, useRef } from 'react';

import { cancelFrame, frame } from 'framer-motion';
import { ReactLenis } from 'lenis/react';

const DataScrollLocked = memo(() => {
  const lenisRef = useRef<LenisRef>(null);
  useEffect(() => {
    function update(data: { timestamp: number }) {
      const time = data.timestamp;
      lenisRef.current?.lenis?.raf(time);
    }
    frame.update(update, true);
    return () => cancelFrame(update);
  }, []);

  return <ReactLenis root options={{ autoRaf: false }} ref={lenisRef} />;
});

DataScrollLocked.displayName = 'DataScrollLocked';

export default DataScrollLocked;
