import { memo } from 'react';

const SectionIcon = memo(
  ({
    className,
    width,
    height,
  }: {
    className?: string;
    width: string | number;
    height: string | number;
  }) => {
    return (
      <svg
        xmlns='http://www.w3.org/2000/svg'
        viewBox='0 0 48 48'
        className={className}
        aria-hidden
        width={width}
        height={height}
      >
        <defs>
          <mask id='SVGsyFatdBT'>
            <g
              fill='none'
              stroke='currentColor'
              strokeLinejoin='round'
              strokeWidth='4'
            >
              <rect
                width='36'
                height='36'
                x='6'
                y='6'
                fill='currentColor'
                fillOpacity={0.5}
                rx='3'
              />
              <path
                strokeLinecap='round'
                d='M6 16h36M6 13v6m36-6v6M17 30h25M17 16v26m-3 0h6m22-15v6'
              />
            </g>
          </mask>
        </defs>
        <path fill='currentColor' d='M0 0h48v48H0z' mask='url(#SVGsyFatdBT)' />
      </svg>
    );
  }
);

SectionIcon.displayName = 'SectionIcon';

export default SectionIcon;
