import { BaseAlignKit } from './plugins/base/align-base-kit';
import { BaseBasicBlocksKit } from './plugins/base/basic-blocks-base-kit';
import { BaseBasicMarksKit } from './plugins/base/basic-marks-base-kit';
import { BaseCalloutKit } from './plugins/base/callout-base-kit';
import { BaseCodeBlockKit } from './plugins/base/code-block-base-kit';
import { BaseColumnKit } from './plugins/base/column-base-kit';
import { BaseCommentKit } from './plugins/base/comment-base-kit';
import { BaseDateKit } from './plugins/base/date-base-kit';
import { BaseFontKit } from './plugins/base/font-base-kit';
import { BaseLineHeightKit } from './plugins/base/line-height-base-kit';
import { BaseLinkKit } from './plugins/base/link-base-kit';
import { BaseListKit } from './plugins/base/list-base-kit';
import { BaseMathKit } from './plugins/base/math-base-kit';
import { BaseMediaKit } from './plugins/base/media-base-kit';
import { BaseSuggestionKit } from './plugins/base/suggestion-base-kit';
import { BaseTableKit } from './plugins/base/table-base-kit';
import { BaseTocKit } from './plugins/base/toc-base-kit';
import { BaseToggleKit } from './plugins/base/toggle-base-kit';
import { DirKit } from './plugins/dir-kit';
import { MarkdownKit } from './plugins/markdown-kit';

export const BaseEditorKit = [
  ...BaseBasicBlocksKit,
  ...BaseCodeBlockKit,
  ...BaseTableKit,
  ...BaseToggleKit,
  ...BaseTocKit,
  ...BaseMediaKit,
  ...BaseCalloutKit,
  ...BaseColumnKit,
  ...BaseMathKit,
  ...BaseDateKit,
  ...BaseLinkKit,
  ...BaseBasicMarksKit,
  ...BaseFontKit,
  ...BaseListKit,
  ...BaseAlignKit,
  ...BaseLineHeightKit,
  ...BaseCommentKit,
  ...BaseSuggestionKit,
  ...MarkdownKit,
  ...DirKit,
];
