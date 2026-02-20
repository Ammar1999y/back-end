import { BaseCalloutPlugin } from '@platejs/callout';

import { CalloutElementStatic } from '@/components/editor/ui/static/callout-node-static';

export const BaseCalloutKit = [
  BaseCalloutPlugin.withComponent(CalloutElementStatic),
];
