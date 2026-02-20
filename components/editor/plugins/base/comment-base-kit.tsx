import { BaseCommentPlugin } from '@platejs/comment';

import { CommentLeafStatic } from '@/components/editor/ui/static/comment-node-static';

export const BaseCommentKit = [
  BaseCommentPlugin.withComponent(CommentLeafStatic),
];
