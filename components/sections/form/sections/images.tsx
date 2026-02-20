import { memo } from 'react';

import { ACCEPT_IMAGES_WITH_SVG } from '@/lib/constants';

import { MAX_IMAGE_SIZE } from '@/utils/images/config';

import Label from '@/components/ui/label';
import { FileUpload } from '@/components/file-upload';

const ImagesSection = memo(() => {
  return (
    <>
      <Label title='الصور' htmlFor='section-images' />
      <FileUpload
        maxFiles={30}
        maxSizeMB={MAX_IMAGE_SIZE}
        accept={ACCEPT_IMAGES_WITH_SVG}
        inputID='section-images'
        dropzoneText='اسحب وأفلت الصور هنا، أو'
      />
    </>
  );
});
ImagesSection.displayName = 'ImagesSection';

export { ImagesSection };
