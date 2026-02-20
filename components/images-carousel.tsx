import type { CarouselOptions } from '@/components/ui/carousel';

import Image from 'next/image';
import { lazy, memo, Suspense, useEffect, useState } from 'react';

import { type CreatePluginType } from 'embla-carousel';
import { cn } from '@/lib/utils';

const Carousel = lazy(() =>
  import('@/components/ui/carousel').then((m) => ({ default: m.Carousel }))
);
const CarouselContent = lazy(() =>
  import('@/components/ui/carousel').then((m) => ({
    default: m.CarouselContent,
  }))
);
const CarouselItem = lazy(() =>
  import('@/components/ui/carousel').then((m) => ({ default: m.CarouselItem }))
);
const CarouselNext = lazy(() =>
  import('@/components/ui/carousel').then((m) => ({ default: m.CarouselNext }))
);
const CarouselPrevious = lazy(() =>
  import('@/components/ui/carousel').then((m) => ({
    default: m.CarouselPrevious,
  }))
);

const opts: CarouselOptions = {
  loop: true,
  dragFree: false,
  align: 'start',
  skipSnaps: false,
};

const Images = memo(({ images, title }: { images: any; title: string }) => {
  const [plugins, setPlugins] = useState<CreatePluginType<any, any>[]>([]);
  useEffect(() => {
    if (!images || !images.length) return;
    import('embla-carousel-autoplay').then((module) => {
      setPlugins([
        module.default({
          delay: 4000,
        }),
      ]);
    });
  }, [images]);
  if (!images || !images.length) return null;
  if (images.length === 1)
    return (
      <ImageItem image={images[0]} isFirst title={title} className='mb-4' />
    );
  return (
    <Suspense fallback={<ImageItem isFirst image={images[0]} title={title} />}>
      <Carousel
        itemsLength={images.length}
        className='relative mb-4 w-full'
        opts={opts}
        plugins={plugins}
      >
        <CarouselContent>
          {images.map((image, idx) =>
            image.url ? (
              <CarouselItem key={idx} className='group basis-full'>
                <ImageItem image={image} title={title} isFirst={idx === 0} />
              </CarouselItem>
            ) : null
          )}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    </Suspense>
  );
});

const ImageItem = memo(
  ({
    image,
    title,
    className,
    isFirst,
  }: {
    image: any;
    title: string;
    className?: string;
    isFirst?: boolean;
  }) => {
    return (
      <Image
        src={image.url}
        alt={title}
        width={400}
        height={300}
        className={cn(
          'h-64 w-full rounded-lg object-cover shadow-md sm:h-80 md:h-96 lg:h-72',
          className
        )}
        loading={isFirst ? 'eager' : 'lazy'}
        priority={isFirst}
        fetchPriority={isFirst ? 'high' : 'auto'}
      />
    );
  }
);
ImageItem.displayName = 'ImageItem';

Images.displayName = 'Images';

export default Images;
