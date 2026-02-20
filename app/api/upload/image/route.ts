import type { NextRequest } from 'next/server';

import { NextResponse } from 'next/server';

import {
  isAllowedImageType,
  uploadImagesToR2,
  validateMagicBytes,
} from '@/lib/r2/upload-helper';

import { CustomError } from '@/utils/error-class';
import { sanitizeFilename } from '@/utils/sanitize-filename';
import { MAX_IMAGE_SIZE } from '@/utils/validation/constants';

const MAX_FILE_SIZE = MAX_IMAGE_SIZE * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 1;

export async function POST(request: NextRequest) {
  try {
    // TODO: Add authentication check when auth is implemented, and rate limiting

    const formData = await request.formData();
    const entries = formData.getAll('files');

    if (entries.length === 0) {
      return NextResponse.json(
        { error: 'لم يتم إرسال ملفات' },
        { status: 400 }
      );
    }

    // Validate file count limit
    if (entries.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        {
          error: `الحد الأقصى ${MAX_FILES_PER_REQUEST} ملفات في الطلب الواحد`,
        },
        { status: 400 }
      );
    }

    // Validate all files
    const files: File[] = [];
    for (const entry of entries) {
      if (!(entry instanceof File)) continue;

      const safeName = sanitizeFilename(entry.name);

      // Validate file size
      if (entry.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          {
            error: `حجم الملف ${safeName} كبير جداً. الحد الأقصى: ${MAX_IMAGE_SIZE}MB`,
          },
          { status: 400 }
        );
      }

      // Validate MIME type
      if (!isAllowedImageType(entry.type)) {
        return NextResponse.json(
          {
            error: `نوع الملف ${safeName} غير مسموح. الأنواع المسموحة: PNG, WebP, SVG`,
          },
          { status: 400 }
        );
      }

      // Validate magic bytes (actual file content)
      const buffer = Buffer.from(await entry.arrayBuffer());
      const magicValidation = validateMagicBytes(buffer, entry.type);
      if (!magicValidation.valid) {
        return NextResponse.json(
          {
            error: `محتوى الملف ${safeName} لا يتطابق مع نوعه المعلن`,
          },
          { status: 400 }
        );
      }

      files.push(entry);
    }

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'لم يتم إرسال ملفات صالحة' },
        { status: 400 }
      );
    }

    // Upload images to R2
    const r2Keys = await uploadImagesToR2({ files });

    return NextResponse.json({ r2Keys });
  } catch (error) {
    console.error('[Upload Image Error]', error);

    if (error instanceof CustomError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status || 500 }
      );
    }

    return NextResponse.json(
      { error: 'حدث خطأ أثناء رفع الملفات' },
      { status: 500 }
    );
  }
}
