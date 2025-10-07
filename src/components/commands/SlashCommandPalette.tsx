"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtom, useAtomValue } from "jotai";
import { Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  slashCommandsQueryKey,
  useSlashCommands,
  useUpdateSlashCommandPrefs,
} from "@/hooks/commands/useSlashCommands";
import { honoClient } from "@/lib/api/client";
import { commandPaletteOpenAtom, commandPaletteInitialInputAtom } from "@/lib/atoms/commandPaletteAtom";
import { currentSessionAtom } from "@/lib/atoms/currentSessionAtom";
import type { CommandRecord, SlashCommandData } from "@/shared/slashCommands";

const parseInput = (
  raw: string,
): { token: string; args: string; raw: string } => {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("/")) return { token: "", args: trimmed, raw };
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { token: trimmed, args: "", raw };
  return {
    token: trimmed.slice(0, spaceIdx),
    args: trimmed.slice(spaceIdx + 1),
    raw,
  };
};

const buildHaystack = (command: CommandRecord): string => {
  return [
    command.name.replace(/^\//, ""),
    ...(command.aliases || []).map((alias) => alias.replace(/^\//, "")),
    command.description ?? "",
    ...(command.tags || []),
  ]
    .join("\n")
    .toLowerCase();
};

const highlightMatch = (text: string, needle: string) => {
  const lower = text.toLowerCase();
  const index = lower.indexOf(needle);
  if (needle.length === 0 || index === -1) {
    return text;
  }
  const before = text.slice(0, index);
  const match = text.slice(index, index + needle.length);
  const after = text.slice(index + needle.length);
  return (
    <span>
      {before}
      <span className="text-primary font-semibold">{match}</span>
      {after}
    </span>
  );
};

export const SlashCommandPalette = () => {
  const [isOpen, setIsOpen] = useAtom(commandPaletteOpenAtom);
  const [initialInput, setInitialInput] = useAtom(commandPaletteInitialInputAtom);
  const { data, isLoading } = useSlashCommands();
  const updatePrefs = useUpdateSlashCommandPrefs();
  const queryClient = useQueryClient();
  const currentSession = useAtomValue(currentSessionAtom);

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseInput(input), [input]);

  const commands = useMemo<CommandRecord[]>(() => {
    if (!data) return [];
    return data.index.order
      .map((id) => data.index.byId[id])
      .filter((c): c is CommandRecord => Boolean(c));
  }, [data]);

  const tokenNorm = parsed.token.replace(/^\//, "").toLowerCase();

  const starredSet = useMemo(
    () => new Set(data?.prefs.starred ?? []),
    [data?.prefs.starred],
  );

  const filtered = useMemo(() => {
    const matchesToken = (command: CommandRecord) => {
      if (!tokenNorm) return true;
      return buildHaystack(command).includes(tokenNorm);
    };

    const list = commands.filter(matchesToken);
    const starred = list.filter((command) => starredSet.has(command.id));
    const rest = list.filter((command) => !starredSet.has(command.id));

    const sortByName = (a: CommandRecord, b: CommandRecord) =>
      a.name.localeCompare(b.name);

    starred.sort(sortByName);
    rest.sort(sortByName);

    return {
      starred,
      rest,
      all: [...starred, ...rest],
    };
  }, [commands, starredSet, tokenNorm]);

  const activeCommand = useMemo(() => {
    if (!parsed.token.startsWith("/")) {
      return filtered.all[0] ?? null;
    }

    return (
      filtered.all.find((command) => command.name === parsed.token) ??
      filtered.all[0] ??
      null
    );
  }, [filtered.all, parsed.token]);

  // Set initial input when command palette opens
  useEffect(() => {
    if (isOpen && initialInput) {
      setInput(initialInput);
      // Focus and position cursor at end after setting input
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        const length = initialInput.length;
        inputRef.current?.setSelectionRange(length, length);
      }, 10);
      setInitialInput(""); // Clear for next time
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOpen, initialInput, setInitialInput]);

  // Normal focus behavior when opening without initial input
  useEffect(() => {
    if (!isOpen) {
      setInput("");
      return;
    }
    // Only run normal focus if there's no initial input
    if (!initialInput) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 10);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [isOpen, initialInput]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsOpen((current) => !current);
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        setIsOpen(true);
      }


      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setIsOpen]);

  const handleToggleStar = (commandId: string) => {
    if (!data) return;
    
    // Update optimistically first for instant feedback
    const nextStarred = toggleStarOptimistic(commandId);
    if (nextStarred) {
      updatePrefs.mutate({ starred: nextStarred });
    }
  };

  const touchRecentOptimistic = (commandId: string): string[] | undefined => {
    let nextRecent: string[] | undefined;
    queryClient.setQueryData<SlashCommandData>(
      slashCommandsQueryKey,
      (prev) => {
        if (!prev) return prev;
        nextRecent = [
          commandId,
          ...prev.prefs.recent.filter((id) => id !== commandId),
        ].slice(0, 20);
        return {
          ...prev,
          prefs: {
            ...prev.prefs,
            recent: nextRecent,
          },
        };
      },
    );
    return nextRecent;
  };

  const toggleStarOptimistic = (commandId: string): string[] | undefined => {
    let nextStarred: string[] | undefined;
    queryClient.setQueryData<SlashCommandData>(
      slashCommandsQueryKey,
      (prev) => {
        if (!prev) return prev;
        const current = prev.prefs.starred;
        nextStarred = current.includes(commandId)
          ? current.filter((id) => id !== commandId)
          : [...current, commandId];
        return {
          ...prev,
          prefs: {
            ...prev.prefs,
            starred: nextStarred,
          },
        };
      },
    );
    return nextStarred;
  };

  const sendCommandMutation = useMutation({
    mutationFn: async ({
      projectId,
      sessionId,
      message,
    }: {
      projectId: string;
      sessionId: string;
      message: string;
    }) => {
      const response = await honoClient.api.projects[":projectId"].sessions[
        ":sessionId"
      ].resume.$post(
        {
          param: { projectId, sessionId },
          json: { resumeMessage: message },
        },
        {
          init: {
            signal: AbortSignal.timeout(20 * 1000),
          },
        },
      );

      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        const messageText =
          body && typeof body === "object" && body !== null && "error" in body
            ? String(body.error)
            : response.statusText;
        throw new Error(messageText || "Failed to send command");
      }

      return response.json();
    },
  });

  const handleRun = (command: CommandRecord | null) => {
    if (!command) return;
    if (!currentSession) {
      toast.error("Select a session before running a command");
      return;
    }

    const commandLine = `${command.name}${parsed.args ? ` ${parsed.args}` : ""}`;

    // Close palette and clear input immediately for instant feedback
    setIsOpen(false);
    setInput("");

    // Update recent commands optimistically
    const nextRecent = touchRecentOptimistic(command.id);
    if (nextRecent) {
      updatePrefs.mutate({ recent: nextRecent });
    }

    // Fire the mutation (response will stream in via SSE)
    sendCommandMutation.mutate(
      {
        projectId: currentSession.projectId,
        sessionId: currentSession.sessionId,
        message: commandLine,
      },
      {
        onError: (error: unknown) => {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to send command to session";
          toast.error(message);
        },
      },
    );
  };

  const handleSelect = (command: CommandRecord) => {
    setInput(`${command.name}${parsed.args ? ` ${parsed.args}` : " "}`);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-2xl p-0 overflow-hidden top-24 left-1/2 -translate-x-1/2 translate-y-0 origin-top">
        <DialogTitle className="sr-only">Command Palette</DialogTitle>
        <div className="border-b px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={"Type / to pick a command…"}
            />
            {input.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setInput("")}
                aria-label="Clear"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
            <Button
              onClick={() => handleRun(activeCommand)}
              disabled={!activeCommand || sendCommandMutation.isPending}
            >
              Run
            </Button>
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto px-4 py-3">
          {isLoading && (
            <p className="text-sm text-muted-foreground">Loading commands…</p>
          )}

          {!isLoading && filtered.all.length === 0 && (
            <p className="text-sm text-muted-foreground">No commands found.</p>
          )}

          {filtered.starred.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-semibold text-muted-foreground mb-2">
                Starred
              </p>
              <div className="space-y-2">
                {filtered.starred.map((command) => (
                  <PaletteItem
                    key={command.id}
                    command={command}
                    highlight={tokenNorm}
                    onSelect={() => handleSelect(command)}
                    onRun={() => handleRun(command)}
                    onToggleStar={() => handleToggleStar(command.id)}
                    isStarred
                  />
                ))}
              </div>
            </div>
          )}

          {filtered.rest.length > 0 && (
            <div className="space-y-2">
              {filtered.rest.map((command) => (
                <PaletteItem
                  key={command.id}
                  command={command}
                  highlight={tokenNorm}
                  onSelect={() => handleSelect(command)}
                  onRun={() => handleRun(command)}
                  onToggleStar={() => handleToggleStar(command.id)}
                  isStarred={false}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

type PaletteItemProps = {
  command: CommandRecord;
  highlight: string;
  onSelect: () => void;
  onRun: () => void;
  onToggleStar: () => void;
  isStarred: boolean;
};

const PaletteItem = ({
  command,
  highlight,
  onSelect,
  onRun,
  onToggleStar,
  isStarred,
}: PaletteItemProps) => {
  return (
    <div
      className="flex w-full items-start justify-between rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onRun();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Select command ${command.name}`}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">
          {highlightMatch(command.name, highlight)}
        </div>
        {command.description && (
          <p className="text-xs text-muted-foreground truncate">
            {highlightMatch(command.description, highlight)}
          </p>
        )}
        {(command.allowedTools?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {(command.allowedTools || []).slice(0, 3).map((tool) => (
              <Badge key={tool} variant="outline" className="text-[10px]">
                {tool}
              </Badge>
            ))}
            {command.allowedTools && command.allowedTools.length > 3 && (
              <Badge variant="outline" className="text-[10px]">
                +{command.allowedTools.length - 3}
              </Badge>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={isStarred ? "Unstar command" : "Star command"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleStar();
          }}
        >
          <Star
            className={`h-4 w-4 ${isStarred ? "fill-current text-yellow-500" : ""}`}
          />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onRun();
          }}
        >
          Run
        </Button>
      </div>
    </div>
  );
};
