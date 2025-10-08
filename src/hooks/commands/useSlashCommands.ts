"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchSlashCommands, patchCommandPrefs } from "@/lib/api/commands";
import type { SlashCommandData, UserPrefs } from "@/shared/slashCommands";

export const slashCommandsQueryKey = ["slash-commands"] as const;

export const useSlashCommands = () => {
  return useQuery({
    queryKey: slashCommandsQueryKey,
    queryFn: async () => await fetchSlashCommands(),
    staleTime: 1000 * 60 * 5,
  });
};

export const useRefreshSlashCommands = () => {
  const queryClient = useQueryClient();
  return async (forceReload = false) => {
    if (forceReload) {
      const fresh = await fetchSlashCommands(true);
      queryClient.setQueryData<SlashCommandData>(slashCommandsQueryKey, fresh);
      return fresh;
    }
    await queryClient.invalidateQueries({ queryKey: slashCommandsQueryKey });
    return queryClient.getQueryData<SlashCommandData>(slashCommandsQueryKey);
  };
};

export const useUpdateSlashCommandPrefs = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (patch: Partial<UserPrefs>) =>
      await patchCommandPrefs(patch),
    onSuccess: (prefs) => {
      queryClient.setQueryData<SlashCommandData>(
        slashCommandsQueryKey,
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            prefs,
          };
        },
      );
    },
  });
};
