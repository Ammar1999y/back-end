import { BaseTogglePlugin } from '@platejs/toggle';

import { ToggleElementStatic } from '@/components/editor/ui/static/toggle-node-static';

export const BaseToggleKit = [
  BaseTogglePlugin.withComponent(ToggleElementStatic),
];
