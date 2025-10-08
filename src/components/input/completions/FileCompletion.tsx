import { useRef } from "react";
import {
  FileCompletion as OriginalFileCompletion,
  type FileCompletionRef,
} from "@/components/projects/chatForm/FileCompletion";
import type { CompletionPlugin, CursorPosition, TriggerMatch } from "../types";

interface PositionStyle {
  top: number;
  left: number;
  placement: "above" | "below";
}

const calculateOptimalPosition = (
  relativeCursorPosition: { top: number; left: number },
  absoluteCursorPosition: { top: number; left: number },
): PositionStyle => {
  const viewportHeight =
    typeof window !== "undefined" ? window.innerHeight : 800;
  const viewportCenter = viewportHeight / 2;

  const estimatedCompletionHeight = 200;

  const isInUpperHalf = absoluteCursorPosition.top < viewportCenter;
  const spaceBelow = viewportHeight - absoluteCursorPosition.top;
  const spaceAbove = absoluteCursorPosition.top;

  let placement: "above" | "below";
  let top: number;

  if (isInUpperHalf && spaceBelow >= estimatedCompletionHeight) {
    placement = "below";
    top = relativeCursorPosition.top + 16;
  } else if (!isInUpperHalf && spaceAbove >= estimatedCompletionHeight) {
    placement = "above";
    top = relativeCursorPosition.top - estimatedCompletionHeight - 8;
  } else {
    if (spaceBelow > spaceAbove) {
      placement = "below";
      top = relativeCursorPosition.top + 16;
    } else {
      placement = "above";
      top = relativeCursorPosition.top - estimatedCompletionHeight - 8;
    }
  }

  const estimatedCompletionWidth = 512;
  const viewportWidth =
    typeof window !== "undefined" ? window.innerWidth : 1200;
  const maxLeft = viewportWidth - estimatedCompletionWidth - 16;
  const adjustedLeft = Math.max(
    16,
    Math.min(relativeCursorPosition.left - 16, maxLeft),
  );

  return {
    top,
    left: adjustedLeft,
    placement,
  };
};

export class FileCompletionPlugin implements CompletionPlugin {
  readonly name = "file-completion";

  render(props: {
    projectId: string;
    input: string;
    match: TriggerMatch;
    cursorPosition: CursorPosition;
    onSelect: (value: string) => void;
    onClose: () => void;
  }) {
    if (props.match.type !== "file-completion") return null;

    const position = calculateOptimalPosition(
      props.cursorPosition.relative,
      props.cursorPosition.absolute,
    );

    return (
      <FileCompletionRenderer
        {...props}
        position={position}
      />
    );
  }

  onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    // File completion handling will be done by the FileCompletion component
    return false;
  }
}

const FileCompletionRenderer: React.FC<{
  projectId: string;
  input: string;
  match: TriggerMatch;
  cursorPosition: CursorPosition;
  onSelect: (value: string) => void;
  onClose: () => void;
  position: PositionStyle;
}> = ({ projectId, input, onSelect, position }) => {
  const fileCompletionRef = useRef<FileCompletionRef>(null);

  return (
    <div
      className="absolute w-full max-w-sm sm:max-w-md lg:max-w-lg xl:max-w-xl"
      style={{
        top: position.top,
        left: position.left,
        maxWidth:
          typeof window !== "undefined"
            ? Math.min(512, window.innerWidth * 0.8)
            : 512,
      }}
    >
      <OriginalFileCompletion
        ref={fileCompletionRef}
        projectId={projectId}
        inputValue={input}
        onFileSelect={onSelect}
        className={`absolute left-0 right-0 ${
          position.placement === "above" ? "bottom-full mb-2" : "top-full mt-1"
        }`}
      />
    </div>
  );
};