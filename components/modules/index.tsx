import { memo } from 'react';

import { ThemeCustomizer } from '../theme-customizer';
import ImageZoomDialog from './image-zoom';
import ModulesHandler from './modules-handler';

const GlobalModules = memo(() => {
  return (
    <>
      <ModulesHandler />
      <ThemeCustomizer />
      <ImageZoomDialog />
    </>
  );
});

GlobalModules.displayName = 'GlobalModules';

export default GlobalModules;
