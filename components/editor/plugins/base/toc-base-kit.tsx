import { BaseTocPlugin } from '@platejs/toc';

import { TocElementStatic } from '@/components/editor/ui/static/toc-node-static';

export const BaseTocKit = [BaseTocPlugin.withComponent(TocElementStatic)];
