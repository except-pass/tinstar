"use client";

import { useEffect } from "react";

import {
  useRefreshSlashCommands,
  useSlashCommands,
} from "@/hooks/commands/useSlashCommands";

export const SlashCommandsBootstrap = () => {
  const { data, isFetched } = useSlashCommands();
  const refresh = useRefreshSlashCommands();

  useEffect(() => {
    if (!isFetched) return;
    if (!data) {
      void refresh(true);
    }
  }, [data, isFetched, refresh]);

  return null;
};
