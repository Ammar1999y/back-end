import { memo } from 'react';

const LanguageIcon = memo(
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
        viewBox='0 0 24 24'
        className={className}
        aria-hidden
        width={width}
        height={height}
        fill='none'
        xmlns='http://www.w3.org/2000/svg'
      >
        <path
          d='M5 5.828H7.7M7.7 5.828H9.5M7.7 5.828V5M11 5.828H9.5M9.5 5.828C9.184 6.959 8.52 8.029 7.764 8.969L8.921 10.172M5.836 11C6.52771 10.3717 7.17213 9.69316 7.764 8.97C7.379 8.517 6.839 7.786 6.684 7.455M13.5 19L14.333 17M14.333 17L16 13L17.667 17M14.333 17H17.667M18.5 19L17.667 17'
          stroke='currentColor'
          strokeWidth='1'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
        <path
          d='M14 9.3V8C14 5.172 14 3.757 13.121 2.879C12.243 2 10.828 2 8 2C5.172 2 3.757 2 2.879 2.879C2 3.757 2 5.172 2 8C2 10.828 2 12.243 2.879 13.121C3.757 14 5.172 14 8 14H9.3'
          stroke='currentColor'
          strokeOpacity='0.4'
          strokeWidth='1.5'
        />
        <path
          d='M10 16C10 13.172 10 11.757 10.879 10.879C11.757 10 13.172 10 16 10C18.828 10 20.243 10 21.121 10.879C22 11.757 22 13.172 22 16C22 18.828 22 20.243 21.121 21.121C20.243 22 18.828 22 16 22C13.172 22 11.757 22 10.879 21.121C10 20.243 10 18.828 10 16Z'
          stroke='currentColor'
          strokeOpacity='0.4'
          strokeWidth='1.5'
        />
        <path
          d='M4 16.5C4 17.904 4 18.607 4.337 19.111C4.48296 19.3295 4.67053 19.517 4.889 19.663C5.393 20 6.096 20 7.5 20M20 7.5C20 6.096 20 5.393 19.663 4.889C19.517 4.67053 19.3295 4.48296 19.111 4.337C18.607 4 17.904 4 16.5 4'
          stroke='currentColor'
          strokeOpacity='0.4'
          strokeWidth='1.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    );
  }
);

LanguageIcon.displayName = 'LanguageIcon';

export default LanguageIcon;
