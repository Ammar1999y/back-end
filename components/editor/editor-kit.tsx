'use client';

import type { Value } from 'platejs';
import type { TPlateEditor } from 'platejs/react';

import { TrailingBlockPlugin } from 'platejs';
import { useEditorRef } from 'platejs/react';

import { AlignKit } from './plugins/align-kit';
import { AutoformatKit } from './plugins/autoformat-kit';
import { BasicBlocksKit } from './plugins/basic-blocks-kit';
import { BasicMarksKit } from './plugins/basic-marks-kit';
import { BlockMenuKit } from './plugins/block-menu-kit';
import { BlockPlaceholderKit } from './plugins/block-placeholder-kit';
import { CalloutKit } from './plugins/callout-kit';
import { CodeBlockKit } from './plugins/code-block-kit';
import { ColumnKit } from './plugins/column-kit';
import { CommentKit } from './plugins/comment-kit';
import { DateKit } from './plugins/date-kit';
import { DirKit } from './plugins/dir-kit';
import { DiscussionKit } from './plugins/discussion-kit';
import { DndKit } from './plugins/dnd-kit';
import { DocxKit } from './plugins/docx-kit';
import { EmojiKit } from './plugins/emoji-kit';
import { ExitBreakKit } from './plugins/exit-break-kit';
import { FixedToolbarKit } from './plugins/fixed-toolbar-kit';
import { FloatingToolbarKit } from './plugins/floating-toolbar-kit';
import { FontKit } from './plugins/font-kit';
import { LineHeightKit } from './plugins/line-height-kit';
import { LinkKit } from './plugins/link-kit';
import { ListKit } from './plugins/list-kit';
import { MarkdownKit } from './plugins/markdown-kit';
import { MathKit } from './plugins/math-kit';
import { MediaKit } from './plugins/media-kit';
import { SlashKit } from './plugins/slash-kit';
import { SuggestionKit } from './plugins/suggestion-kit';
import { TableKit } from './plugins/table-kit';
import { TocKit } from './plugins/toc-kit';
import { ToggleKit } from './plugins/toggle-kit';

export const EditorKit = [
  // Elements

  // عناصر أساسية: فقرة، 6 عناوين، اقتباس، خط أفقي
  ...BasicBlocksKit,

  // بلوكات كود برمجي مع syntax highlighting
  ...CodeBlockKit,

  // جداول قابلة للتعديل (إضافة/حذف صفوف وأعمدة)
  ...TableKit,

  // عناصر قابلة للطي/فتح (collapse/expand)
  ...ToggleKit,

  // جدول محتويات تلقائي من العناوين + تنقل سريع
  ...TocKit,

  // صور، فيديو، ملفات + رفع drag & drop
  ...MediaKit,

  // مربعات تنبيه/ملاحظات ملونة (info, warning, error...)
  ...CalloutKit,

  // تقسيم المحتوى لأعمدة متعددة
  ...ColumnKit,

  // معادلات رياضية (LaTeX/KaTeX)
  ...MathKit,

  // إدراج تواريخ مع date picker
  ...DateKit,

  // روابط تشعبية مع معاينة
  ...LinkKit,

  // Marks

  // تنسيق نص: Bold, Italic, Underline, Code, Strike, Sub/Sup, Highlight, Kbd
  ...BasicMarksKit,

  // حجم ونوع الخط + لون النص/الخلفية
  ...FontKit,

  // Block Style

  // قوائم: مرقمة، نقطية، todo checkboxes
  ...ListKit,

  // محاذاة: يمين، يسار، وسط، justify
  ...AlignKit,

  // اتجاه النص: RTL, LTR, Auto
  ...DirKit,

  // تحكم بارتفاع السطر (line-height)
  ...LineHeightKit,

  // Collaboration

  // نظام نقاشات متعدد المستخدمين (threads)
  ...DiscussionKit,

  // تعليقات على النص المحدد
  ...CommentKit,

  // اقتراحات تعديل (track changes)
  ...SuggestionKit,

  // Editing

  // قائمة أوامر سريعة بـ / (slash commands)
  ...SlashKit,

  // تنسيق تلقائي Markdown (## عنوان، **bold**، - قائمة...)
  ...AutoformatKit,

  // قائمة سياق عند تحديد عنصر (copy, delete, turn into...)
  ...BlockMenuKit,

  // سحب وإفلات العناصر لإعادة ترتيبها
  ...DndKit,

  // إيموجي picker
  ...EmojiKit,

  // كسر خروج من عناصر (Shift+Enter في quote/code...)
  ...ExitBreakKit,

  // يضمن وجود فقرة فارغة نهائية دائماً
  TrailingBlockPlugin,

  // Parsers

  // استيراد/تصدير ملفات Word (.docx)
  ...DocxKit,

  // استيراد/تصدير Markdown
  ...MarkdownKit,

  // نص placeholder للعناصر الفارغة
  ...BlockPlaceholderKit,

  // شريط أدوات ثابت في الأعلى
  ...FixedToolbarKit,

  // شريط أدوات عائم عند تحديد نص
  ...FloatingToolbarKit,
];

export type MyEditor = TPlateEditor<Value, (typeof EditorKit)[number]>;

export const useEditor = () => useEditorRef<MyEditor>();
