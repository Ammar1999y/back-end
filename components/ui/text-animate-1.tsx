import type { MotionProps, Transition, Variants } from 'framer-motion';
import type { CSSProperties } from 'react';

import { ElementType, memo } from 'react';

import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

type AnimationType = 'text' | 'word' | 'character' | 'line';

type AnimationVariant =
  | 'fadeIn'
  | 'fadeInBlur'
  | 'blurIn'
  | 'blurInUp'
  | 'blurInDown'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'scaleUp'
  | 'scaleDown';

interface TextAnimateProps extends MotionProps {
  /**
   * The text content to animate
   */
  text: string;
  /**
   * The class name to be applied to the component
   */
  className?: string;
  /**
   * The class name to be applied to each animated segment
   */
  segmentClassName?: string;
  /**
   * Optional wrapper class applied around each segment (non-motion span)
   */
  segmentWrapperClassName?: string;
  /**
   * The delay before the animation starts (applies to container delayChildren)
   */
  delay?: number;
  /**
   * Total reveal duration used to compute stagger across segments
   */
  duration?: number;
  /**
   * Custom motion variants for the item (legacy). Prefer itemVariants/containerVariants.
   */
  variants?: Variants;
  /**
   * Custom item variants override
   */
  itemVariants?: Variants;
  /**
   * Custom container variants override
   */
  containerVariants?: Variants;
  /**
   * Custom transition for container (merged into show/exit).
   */
  containerTransition?: Transition & { exit?: Transition };
  /**
   * Custom transition for each segment (merged into show/exit).
   */
  segmentTransition?: Transition;
  /**
   * The element type to render
   */
  as?: ElementType;
  /**
   * How to split the text ("text", "word", "character", "line")
   */
  by?: AnimationType;
  /**
   * Alias for by: 'word' | 'char' | 'line' | 'text'
   */
  per?: 'word' | 'char' | 'line' | 'text';
  /**
   * Whether to start animation when component enters viewport
   */
  startOnView?: boolean;
  /**
   * Whether to animate only once
   */
  once?: boolean;
  /**
   * The animation preset to use
   */
  animation?: AnimationVariant;
  /**
   * Speed multiplier for reveal (higher is faster).
   */
  speedReveal?: number;
  /**
   * Speed multiplier for each segment's own animation (higher is faster).
   */
  speedSegment?: number;
  /**
   * Controls mounting of the animated content. If false, content unmounts with exit animation.
   */
  trigger?: boolean;
  /**
   * Motion callbacks
   */
  onAnimationComplete?: () => void;
  /**
   * Style on container element
   */
  style?: CSSProperties;
  /**
   * The amount of the viewport to trigger the animation
   */
  amount?: number;
}

const defaultContainerVariants = {
  hidden: { opacity: 1 },
  show: {
    opacity: 1,
    transition: {
      delayChildren: 0,
      staggerChildren: 0.05,
    },
  },
  exit: {
    opacity: 0,
    transition: {
      staggerChildren: 0.05,
      staggerDirection: -1,
    },
  },
};

const defaultItemAnimationVariants: Record<
  AnimationVariant,
  { container: Variants; item: Variants }
> = {
  fadeIn: {
    container: defaultContainerVariants,
    item: {
      hidden: { opacity: 0, y: 20 },
      show: {
        opacity: 1,
        y: 0,
        transition: {
          duration: 0.3,
        },
      },
      exit: {
        opacity: 0,
        y: 20,
        transition: { duration: 0.3 },
      },
    },
  },
  fadeInBlur: {
    container: defaultContainerVariants,
    item: {
      hidden: { opacity: 0, y: 20, filter: 'blur(6px)' },
      show: {
        opacity: 1,
        y: 0,
        filter: 'blur(0px)',
        transition: {
          duration: 0.3,
        },
      },
      exit: {
        opacity: 0,
        y: 20,
        filter: 'blur(6px)',
        transition: { duration: 0.3 },
      },
    },
  },
  blurIn: {
    container: defaultContainerVariants,
    item: {
      hidden: { opacity: 0, filter: 'blur(10px)' },
      show: {
        opacity: 1,
        filter: 'blur(0px)',
        transition: {
          duration: 0.3,
        },
      },
      exit: {
        opacity: 0,
        filter: 'blur(10px)',
        transition: { duration: 0.3 },
      },
    },
  },
  blurInUp: {
    container: defaultContainerVariants,
    item: {
      hidden: { opacity: 0, filter: 'blur(10px)', y: 20 },
      show: {
        opacity: 1,
        filter: 'blur(0px)',
        y: 0,
        transition: {
          y: { duration: 0.3 },
          opacity: { duration: 0.4 },
          filter: { duration: 0.3 },
        },
      },
      exit: {
        opacity: 0,
        filter: 'blur(10px)',
        y: 20,
        transition: {
          y: { duration: 0.3 },
          opacity: { duration: 0.4 },
          filter: { duration: 0.3 },
        },
      },
    },
  },
  blurInDown: {
    container: defaultContainerVariants,
    item: {
      hidden: { opacity: 0, filter: 'blur(10px)', y: -20 },
      show: {
        opacity: 1,
        filter: 'blur(0px)',
        y: 0,
        transition: {
          y: { duration: 0.3 },
          opacity: { duration: 0.4 },
          filter: { duration: 0.3 },
        },
      },
    },
  },
  slideUp: {
    container: defaultContainerVariants,
    item: {
      hidden: { y: 20, opacity: 0 },
      show: {
        y: 0,
        opacity: 1,
        transition: {
          duration: 0.3,
        },
      },
      exit: {
        y: -20,
        opacity: 0,
        transition: {
          duration: 0.3,
        },
      },
    },
  },
  slideDown: {
    container: defaultContainerVariants,
    item: {
      hidden: { y: -20, opacity: 0 },
      show: {
        y: 0,
        opacity: 1,
        transition: { duration: 0.3 },
      },
      exit: {
        y: 20,
        opacity: 0,
        transition: { duration: 0.3 },
      },
    },
  },
  slideLeft: {
    container: defaultContainerVariants,
    item: {
      hidden: { x: 20, opacity: 0, scaleX: 1.2 },
      show: {
        x: 0,
        opacity: 1,
        scaleX: 1,
        transition: { duration: 0.3 },
      },
      exit: {
        x: -20,
        opacity: 0,
        scaleX: 1.2,
        transition: { duration: 0.3 },
      },
    },
  },
  slideRight: {
    container: defaultContainerVariants,
    item: {
      hidden: { x: -20, opacity: 0, scaleX: 1.2, filter: 'blur(4px)' },
      show: {
        x: 0,
        opacity: 1,
        scaleX: 1,
        filter: 'blur(0px)',
        transition: { duration: 0.3 },
      },
      exit: {
        x: 20,
        opacity: 0,
        scaleX: 1.2,
        filter: 'blur(4px)',
        transition: { duration: 0.3 },
      },
    },
  },
  scaleUp: {
    container: defaultContainerVariants,
    item: {
      hidden: { scale: 0.5, opacity: 0 },
      show: {
        scale: 1,
        opacity: 1,
        transition: {
          duration: 0.3,
          scale: {
            type: 'spring',
            damping: 15,
            stiffness: 300,
          },
        },
      },
      exit: {
        scale: 0.5,
        opacity: 0,
        transition: { duration: 0.3 },
      },
    },
  },
  scaleDown: {
    container: defaultContainerVariants,
    item: {
      hidden: { scale: 1.5, opacity: 0 },
      show: {
        scale: 1,
        opacity: 1,
        transition: {
          duration: 0.3,
          scale: {
            type: 'spring',
            damping: 15,
            stiffness: 300,
          },
        },
      },
      exit: {
        scale: 1.5,
        opacity: 0,
        transition: { duration: 0.3 },
      },
    },
  },
};

function mergeContainerTransitions(
  base: Variants,
  options: {
    delayChildren: number;
    staggerChildren: number;
    containerTransition?: Transition & { exit?: Transition };
  }
): Variants {
  const showBase = (base.show || {}) as Record<string, unknown>;
  const exitBase = (base.exit || {}) as Record<string, unknown>;

  const baseShowTransition = (showBase.transition || {}) as Record<
    string,
    unknown
  >;
  const baseExitTransition = (exitBase.transition || {}) as Record<
    string,
    unknown
  >;

  const showTransition: Record<string, unknown> = {
    ...baseShowTransition,
    delayChildren: options.delayChildren,
    staggerChildren: options.staggerChildren,
  };
  if (options.containerTransition) {
    Object.assign(showTransition, options.containerTransition);
  }

  const exitTransition: Record<string, unknown> = {
    ...baseExitTransition,
    staggerChildren: options.staggerChildren,
    staggerDirection: -1,
  };
  if (options.containerTransition) {
    Object.assign(exitTransition, options.containerTransition);
  }
  if (options.containerTransition?.exit) {
    Object.assign(exitTransition, options.containerTransition.exit);
  }

  return {
    ...base,
    show: {
      ...showBase,
      transition: showTransition,
    },
    exit: {
      ...exitBase,
      transition: exitTransition,
    },
  } as Variants;
}

function mergeItemTransitions(
  base: Variants,
  options: { baseDuration: number; segmentTransition?: Transition }
): Variants {
  const showBase = (base.show || {}) as Record<string, unknown>;
  const exitBase = (base.exit || {}) as Record<string, unknown>;

  const baseShowTransition = (showBase.transition || {}) as Record<
    string,
    unknown
  >;
  const baseExitTransition = (exitBase.transition || {}) as Record<
    string,
    unknown
  >;

  const showTransition: Record<string, unknown> = {
    ...baseShowTransition,
    duration: options.baseDuration,
  };
  if (options.segmentTransition) {
    Object.assign(showTransition, options.segmentTransition);
  }

  const exitTransition: Record<string, unknown> = {
    ...baseExitTransition,
    duration: options.baseDuration,
  };
  if (options.segmentTransition) {
    Object.assign(exitTransition, options.segmentTransition);
  }

  return {
    ...base,
    show: {
      ...showBase,
      transition: showTransition,
    },
    exit: {
      ...exitBase,
      transition: exitTransition,
    },
  } as Variants;
}

const TextAnimateBase = ({
  text,
  delay = 0,
  duration = 0.3,
  variants,
  amount = 0.8,
  itemVariants,
  containerVariants,
  containerTransition,
  segmentTransition,
  className,
  segmentClassName,
  segmentWrapperClassName,
  as: Component = 'p',
  startOnView = true,
  once = false,
  by = 'word',
  animation = 'fadeIn',
  speedReveal = 1,
  speedSegment = 1,
  trigger = true,
  onAnimationComplete,
  style,
  ...props
}: TextAnimateProps) => {
  const MotionComponent = motion.create(Component);

  let segments: string[] = [];
  switch (by) {
    case 'word': {
      segments = text.split(/(\s+)/);
      break;
    }
    case 'character': {
      segments = [...text];
      break;
    }
    case 'line': {
      segments = text.split('\n');
      break;
    }
    case 'text': {
      segments = [text];
      break;
    }
    default: {
      segments = [text];
      break;
    }
  }

  const segmentsCount = Math.max(segments.length, 1);
  const computedStagger =
    duration / segmentsCount / Math.max(speedReveal, 0.0001);
  const baseItemDuration = 0.3 / Math.max(speedSegment, 0.0001);

  const baseContainer = containerVariants || {
    ...defaultItemAnimationVariants[animation].container,
    show: {
      ...defaultItemAnimationVariants[animation].container.show,
    },
    exit: {
      ...defaultItemAnimationVariants[animation].container.exit,
    },
  };

  const baseItem =
    itemVariants || variants || defaultItemAnimationVariants[animation].item;

  const finalVariants = {
    container: mergeContainerTransitions(baseContainer as Variants, {
      delayChildren: delay,
      staggerChildren: computedStagger,
      containerTransition,
    }),
    item: mergeItemTransitions(baseItem as Variants, {
      baseDuration: baseItemDuration,
      segmentTransition,
    }),
  } as { container: Variants; item: Variants };

  return (
    <AnimatePresence mode='popLayout'>
      {trigger && (
        <MotionComponent
          variants={finalVariants.container as Variants}
          initial='hidden'
          whileInView={startOnView ? 'show' : undefined}
          animate={startOnView ? undefined : 'show'}
          exit='exit'
          className={`whitespace-pre-wrap ${className}`}
          viewport={{ once, amount }}
          onAnimationComplete={onAnimationComplete}
          style={style}
          {...props}
        >
          <span className='sr-only'>{text}</span>
          {segments.map((segment, i) => {
            const inner = (
              <motion.span
                key={`${by}-${segment}-${i}`}
                variants={finalVariants.item}
                className={cn(
                  (by === 'line' && 'block') || 'inline-block whitespace-pre',
                  segmentClassName
                )}
                aria-hidden='true'
              >
                {segment}
              </motion.span>
            );

            if (!segmentWrapperClassName) return inner;

            return (
              <span
                key={`wrap-${by}-${segment}-${i}`}
                className={cn(
                  (by === 'line' && 'block') || 'inline-block',
                  segmentWrapperClassName
                )}
              >
                {inner}
              </span>
            );
          })}
        </MotionComponent>
      )}
    </AnimatePresence>
  );
};

// Export the memoized version
export const TextAnimate = memo(TextAnimateBase);
