"use client";

import { useAtom } from "jotai";
import { Command, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { commandPaletteOpenAtom } from "@/lib/atoms/commandPaletteAtom";

export const SlashCommandPaletteButton = () => {
  const [, setIsOpen] = useAtom(commandPaletteOpenAtom);

  return (
    <Button
      className="fixed bottom-24 right-6 shadow-lg"
      size="lg"
      onClick={() => setIsOpen(true)}
    >
      <Sparkles className="mr-2 h-4 w-4" />
      Commands
      <span className="ml-3 flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
        <Command className="h-3 w-3" />K
      </span>
    </Button>
  );
};
