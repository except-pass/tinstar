import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { honoClient } from "../../lib/api/client";
import type { Config } from "../../server/config/config";

export const configQueryConfig = {
  queryKey: ["config"],
  queryFn: async () => {
    const response = await honoClient.api.config.$get();
    return await response.json();
  },
} as const;

export const useConfig = () => {
  const queryClient = useQueryClient();

  const { data } = useSuspenseQuery({
    ...configQueryConfig,
  });
  const updateConfigMutation = useMutation({
    mutationFn: async (config: Config) => {
      const response = await honoClient.api.config.$put({
        json: config,
      });
      return await response.json();
    },
    onMutate: async (newConfig: Config) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: configQueryConfig.queryKey });
      
      // Snapshot the previous value
      const previousConfig = queryClient.getQueryData(configQueryConfig.queryKey);
      
      // Optimistically update to the new value
      queryClient.setQueryData(configQueryConfig.queryKey, { config: newConfig });
      
      // Return a context object with the snapshotted value
      return { previousConfig };
    },
    onError: (err, newConfig, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousConfig) {
        queryClient.setQueryData(configQueryConfig.queryKey, context.previousConfig);
      }
    },
    // Removed onSettled to avoid unnecessary refetch - optimistic update is sufficient
  });

  return {
    config: data?.config,
    isUpdating: updateConfigMutation.isPending,
    updateConfig: useCallback(
      (config: Config) => {
        updateConfigMutation.mutate(config);
      },
      [updateConfigMutation],
    ),
  } as const;
};
