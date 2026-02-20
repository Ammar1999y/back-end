import { memo, useCallback, useMemo, useState } from 'react';

import AutoScroll from '@/lib/embla-carousel/auto-scroll';
import { cn } from '@/lib/utils';

import { useUserPresence } from '@/hooks/use-is-page-active';
import {
  Carousel,
  CarouselApi,
  CarouselOptions,
} from '@/components/ui/carousel';

const carouselStyle = {
  maskImage:
    'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
  WebkitMaskImage:
    'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
};

const InfiniteCarousel = memo(
  ({
    direction,
    children,
    className,
    itemsLength,
  }: {
    direction: 'ltr' | 'rtl';
    children: React.ReactNode;
    className?: string;
    itemsLength: number;
  }) => {
    const plugins = useMemo(
      () => [
        AutoScroll({
          playOnInit: true,
          stopOnInteraction: true,
          speed: 1,
          startDelay: 0,
        }),
      ],
      []
    );

    const [emblaApi, setApi] = useState<CarouselApi>();

    const onMouseEnter = useCallback(() => {
      const autoScroll = emblaApi?.plugins()?.autoScroll;
      if (!autoScroll) return;
      autoScroll.setSpeed(() => 0.4);
    }, [emblaApi]);
    useUserPresence({
      onLeave: () => {
        const autoScroll = emblaApi?.plugins()?.autoScroll;
        if (!autoScroll) return;
        autoScroll.stop();
      },
      onReturn: () => {
        const autoScroll = emblaApi?.plugins()?.autoScroll;
        if (!autoScroll) return;
        autoScroll.play();
      },
    });

    const onMouseLeave = useCallback(() => {
      const autoScroll = emblaApi?.plugins()?.autoScroll;
      if (!autoScroll) return;
      autoScroll.setSpeed(() => 1);
      setTimeout(() => {
        autoScroll.play();
      }, 1000);
    }, [emblaApi]);
    const opts: CarouselOptions = useMemo(
      () => ({
        dragFree: true,
        loop: true,
        align: 'start',
        direction,
        skipSnaps: false,
        inViewThreshold: 0.7,
      }),
      [direction]
    );

    return (
      <Carousel
        itemsLength={itemsLength}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        setApi={setApi}
        className={cn('relative w-full select-none', className)}
        opts={opts}
        style={carouselStyle}
        plugins={plugins}
        dir={direction}
      >
        {children}
      </Carousel>
    );
  }
);

InfiniteCarousel.displayName = 'InfiniteCarousel';

export default InfiniteCarousel;
