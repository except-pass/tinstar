"use client";

import { useAtom } from "jotai";
import type { FC } from "react";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { editorSettingsAtom } from "@/lib/atoms/editorSettings";

export const EditorSettings: FC = () => {
  const [settings, setSettings] = useAtom(editorSettingsAtom);
  const editorCommandId = useId();

  const handleCommandChange = (value: string) => {
    setSettings({ ...settings, editorCommand: value });
  };

  const examples = [
    { name: "Cursor", command: "cursor {{path}}" },
    { name: "VSCode", command: "code {{path}}" },
    { name: "Sublime Text", command: "subl {{path}}" },
    { name: "Vim", command: "vim {{path}}" },
    { name: "Neovim", command: "nvim {{path}}" },
    { name: "Emacs", command: "emacs {{path}}" },
  ];

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="text-xs font-medium text-sidebar-foreground">
          Editor Command
        </div>
        <Input
          id={editorCommandId}
          type="text"
          value={settings.editorCommand}
          onChange={(e) => handleCommandChange(e.target.value)}
          placeholder="Leave empty to use $EDITOR or cursor"
          className="h-8 text-xs"
        />
        <p className="text-[10px] text-sidebar-foreground/60">
          Use {"{{path}}"} as placeholder for the file/directory path
        </p>
      </div>

      <div className="space-y-1">
        <p className="text-[10px] font-medium text-sidebar-foreground/70">
          Examples:
        </p>
        <div className="text-[10px] text-sidebar-foreground/60 space-y-0.5">
          {examples.map((example) => (
            <div key={example.name}>
              <span className="font-medium">{example.name}:</span>{" "}
              <code className="bg-sidebar-accent/30 px-1 rounded">
                {example.command}
              </code>
            </div>
          ))}
        </div>
      </div>

      {!settings.editorCommand && (
        <div className="text-[10px] text-sidebar-foreground/60 bg-sidebar-accent/20 p-2 rounded">
          Currently using: $EDITOR environment variable or "cursor {"{{path}}"}"
          as fallback
        </div>
      )}
    </div>
  );
};
