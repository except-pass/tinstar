import { useAtom } from "jotai";
import {
  commandPaletteInitialInputAtom,
  commandPaletteOpenAtom,
} from "@/lib/atoms/commandPaletteAtom";
import type { TriggerContext, TriggerMatch, TriggerPlugin } from "../types";

export class SlashCommandTrigger implements TriggerPlugin {
  readonly name = "slash-command";
  readonly triggers = ["/"];

  private setCommandPaletteOpen: (open: boolean) => void = () => {};
  private setCommandPaletteInitialInput: (input: string) => void = () => {};

  detect(input: string, cursorPosition: number): TriggerMatch | null {
    // Check if cursor is at the start and input begins with "/"
    if (input === "/" && cursorPosition === 1) {
      return {
        type: "slash-command",
        trigger: "/",
        position: 0,
        query: "",
        fullMatch: "/",
      };
    }

    return null;
  }

  onTrigger(_match: TriggerMatch, _context: TriggerContext): void {
    // Open command palette
    this.setCommandPaletteInitialInput("/");
    this.setCommandPaletteOpen(true);
  }

  onDeactivate(): void {
    // Command palette handles its own closing
  }

  // Method to set the atom setters from React component
  setAtomSetters(
    setOpen: (open: boolean) => void,
    setInitialInput: (input: string) => void,
  ) {
    this.setCommandPaletteOpen = setOpen;
    this.setCommandPaletteInitialInput = setInitialInput;
  }
}

// Hook to create and configure the trigger
export const useSlashCommandTrigger = (): SlashCommandTrigger => {
  const [, setCommandPaletteOpen] = useAtom(commandPaletteOpenAtom);
  const [, setCommandPaletteInitialInput] = useAtom(
    commandPaletteInitialInputAtom,
  );

  const trigger = new SlashCommandTrigger();
  trigger.setAtomSetters(setCommandPaletteOpen, setCommandPaletteInitialInput);

  return trigger;
};
