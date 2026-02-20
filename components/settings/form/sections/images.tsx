import { memo } from 'react';

import { ACCEPT_IMAGES_WITH_SVG } from '@/lib/constants';

import { MAX_IMAGE_SIZE } from '@/utils/images/config';

import Label from '@/components/ui/label';
import { FileUpload } from '@/components/file-upload';

const ImagesSection = memo(() => {
  return (
    <div className='grid grid-cols-1 gap-8 md:grid-cols-2'>
      {/* Favicon / Main Site Icon */}
      <div>
        <Label title='أيقونة الموقع الرئيسية' htmlFor='favicon-image' />
        <FileUpload
          maxFiles={1}
          maxSizeMB={MAX_IMAGE_SIZE}
          accept={ACCEPT_IMAGES_WITH_SVG}
          inputID='favicon-image'
          dropzoneText='اسحب وأفلت الصورة هنا، أو'
          dropzoneHelperText='أبعاد مُفضلة: 512×512 بكسل'
        />
      </div>

      {/* Site Icon Large */}
      <div>
        <Label title='أيقونة الموقع الكبيرة' htmlFor='site-icon-large' />
        <FileUpload
          maxFiles={1}
          maxSizeMB={MAX_IMAGE_SIZE}
          accept={ACCEPT_IMAGES_WITH_SVG}
          inputID='site-icon-large'
          dropzoneText='اسحب وأفلت الصورة هنا، أو'
        />
      </div>

      {/* Site Icon Small */}
      <div>
        <Label title='أيقونة الموقع الصغيرة' htmlFor='site-icon-small' />
        <FileUpload
          maxFiles={1}
          maxSizeMB={MAX_IMAGE_SIZE}
          accept={ACCEPT_IMAGES_WITH_SVG}
          inputID='site-icon-small'
          dropzoneText='اسحب وأفلت الصورة هنا، أو'
        />
      </div>

      {/* OpenGraph Image */}
      <div className='flex flex-col'>
        <Label title='صورة OpenGraph' htmlFor='og-image' />
        <FileUpload
          maxFiles={1}
          maxSizeMB={MAX_IMAGE_SIZE}
          accept={ACCEPT_IMAGES_WITH_SVG}
          inputID='og-image'
          dropzoneText='اسحب وأفلت الصورة هنا، أو'
          dropzoneHelperText='أبعاد مُفضلة: 1200×630 بكسل'
        />
        <p className='mt-2 text-sm text-muted-foreground'>
          تظهر عند مشاركة الموقع على منصات التواصل الاجتماعي. الأبعاد المُفضلة:
          1200×630 بكسل.
        </p>
      </div>
    </div>
  );
});

ImagesSection.displayName = 'ImagesSection';

export { ImagesSection };
