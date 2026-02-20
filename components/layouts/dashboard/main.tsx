import { cn } from '@/lib/utils';

const Main = ({
  children,
  className,
  ...props
}: React.ComponentProps<'main'>) => {
  return (
    <main
      className={cn(
        'container-padding container rounded-lg pb-6 pt-8',
        'transition-[max-width] duration-300 ease-in-out',
        className
      )}
      {...props}
    >
      {children}
    </main>
  );
};

export default Main;
