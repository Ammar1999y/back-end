import React, { useCallback, useState } from 'react';

import { insertImage, insertMediaEmbed } from '@platejs/media';
import { LinkIcon, Loader2Icon, UploadCloudIcon } from 'lucide-react';
import { useEditorRef } from 'platejs/react';
import { FileRejection, useDropzone } from 'react-dropzone';
import { toast } from 'sonner';

import { useUploadFile } from '@/hooks/use-upload-file';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import Label from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { mediaConfig, MediaType } from '@/components/editor/media-config';

interface MediaUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: MediaType;
}

export function MediaUploadDialog({
  open,
  onOpenChange,
  type,
}: MediaUploadDialogProps) {
  const editor = useEditorRef();
  const [url, setUrl] = useState('');
  const [activeTab, setActiveTab] = useState('upload');
  const config = mediaConfig[type];

  const { uploadFile, isUploading, progress } = useUploadFile({
    onUploadComplete: (file) => {
      insertMedia(file.url);
      onOpenChange(false);
      toast.success('تم رفع الملف بنجاح');
    },
  });

  const insertMedia = (mediaUrl: string) => {
    if (!mediaUrl) return;

    switch (type) {
      case 'image':
        insertImage(editor, mediaUrl);
        break;
      case 'video':
      case 'audio':
      case 'file':
        // For now using insertMediaEmbed for video/audio as a placeholder
        // You might want to use specific insert functions for video/audio if available in your setup
        insertMediaEmbed(editor, { url: mediaUrl, type });
        break;
      default:
        break;
    }
  };

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        await uploadFile(acceptedFiles[0], type);
      }
    },
    [uploadFile, type]
  );

  const onDropRejected = useCallback(
    (rejections: FileRejection[]) => {
      const rejection = rejections[0];
      if (!rejection) return;

      const errorCode = rejection.errors[0]?.code;
      let errorMessage: string;

      switch (errorCode) {
        case 'file-too-large':
          errorMessage = `حجم الملف يتجاوز الحد الأقصى (${config.maxSize}MB)`;
          break;
        case 'file-invalid-type':
          errorMessage = 'صيغة الملف غير مدعومة';
          break;
        case 'too-many-files':
          errorMessage = 'يمكن رفع ملف واحد فقط';
          break;
        default:
          errorMessage = 'فشل في رفع الملف';
      }

      toast.error('خطأ في الملف', { description: errorMessage });
    },
    [config.maxSize]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
    // eslint-disable-next-line unicorn/prefer-object-from-entries
    accept: config.accept.reduce((acc, curr) => ({ ...acc, [curr]: [] }), {}),
    maxFiles: 1,
    maxSize: (config.maxSize || 5) * 1024 * 1024, // Convert MB to Bytes
    multiple: false,
  });

  const handleLinkSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url) {
      insertMedia(url);
      onOpenChange(false);
      setUrl('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[425px]'>
        <DialogHeader>
          <DialogTitle>إضافة {config.label}</DialogTitle>
        </DialogHeader>

        <Tabs
          defaultValue='upload'
          value={activeTab}
          onValueChange={setActiveTab}
          className='w-full'
        >
          <TabsList className='grid w-full grid-cols-2'>
            <TabsTrigger value='upload'>رفع من الجهاز</TabsTrigger>
            <TabsTrigger value='link'>رابط خارجي</TabsTrigger>
          </TabsList>

          <TabsContent value='upload' className='mt-4'>
            <div
              {...getRootProps()}
              className={`flex h-48 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${isDragActive ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-primary/50'} `}
            >
              <input {...getInputProps()} />
              {isUploading ? (
                <div className='flex flex-col items-center gap-2'>
                  <Loader2Icon className='h-8 w-8 animate-spin text-primary' />
                  <p className='text-sm text-muted-foreground'>
                    جاري الرفع... {progress}%
                  </p>
                </div>
              ) : (
                <>
                  <UploadCloudIcon className='h-10 w-10 text-muted-foreground' />
                  <p className='text-sm font-medium'>
                    اسحب الملف هنا أو انقر للاختيار
                  </p>
                  <p className='text-xs text-muted-foreground'>
                    {config.accept.join(', ')} (الحد الأقصى {config.maxSize}MB)
                  </p>
                </>
              )}
            </div>
          </TabsContent>

          <TabsContent value='link' className='mt-4'>
            <form onSubmit={handleLinkSubmit} className='flex flex-col gap-4'>
              <div className='grid gap-2'>
                <Label htmlFor='url' title={`رابط ${config.label}`} />
                <div className='relative'>
                  <LinkIcon className='absolute left-3 top-2.5 h-4 w-4 text-muted-foreground' />
                  <Input
                    id='url'
                    placeholder={`https://example.com/${type}...`}
                    className='pl-9'
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button type='submit' disabled={!url}>
                  إضافة
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
