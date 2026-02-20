'use client';

import { memo, useCallback, useMemo } from 'react';

import { Plate, usePlateEditor } from 'platejs/react';

import { EditorKit } from './editor-kit';
import { Editor, EditorContainer } from './ui/editor';

const PlateEditor = memo(
  ({
    content = [],
    onChange,
  }: {
    content: any;
    onChange: (value: any) => void;
  }) => {
    const initialValue = useMemo(
      () => (Array.isArray(content) ? content : []),
      [content]
    );
    const editor = usePlateEditor({
      plugins: EditorKit,
      value: initialValue,
    });
    const onBlur = useCallback(
      () => onChange(editor.children),
      [editor.children, onChange]
    );
    return (
      <Plate editor={editor}>
        <EditorContainer>
          <Editor variant='demo' onBlur={onBlur} />
        </EditorContainer>
      </Plate>
    );
  }
);

PlateEditor.displayName = 'PlateEditor';
export default PlateEditor;
