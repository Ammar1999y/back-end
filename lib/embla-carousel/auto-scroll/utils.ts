import type { RootNodeType } from './options';
import type { EmblaCarouselType } from 'embla-carousel';

export function getAutoScrollRootNode(
  emblaApi: EmblaCarouselType,
  rootNode: RootNodeType
): HTMLElement {
  const emblaRootNode = emblaApi.rootNode();
  return (rootNode && rootNode(emblaRootNode)) || emblaRootNode;
}
