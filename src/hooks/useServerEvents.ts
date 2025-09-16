import { useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";
import { aliveTasksAtom } from "../app/projects/[projectId]/sessions/[sessionId]/store/aliveTasksAtom";
import { projetsQueryConfig } from "../app/projects/hooks/useProjects";
import { honoClient } from "../lib/api/client";
import type { SSEEvent } from "../server/service/events/types";

type ParsedEvent = {
  event: string;
  data: SSEEvent;
  id: string;
};

const parseSSEEvent = (text: string): ParsedEvent => {
  const lines = text.split("\n");
  const eventIndex = lines.findIndex((line) => line.startsWith("event:"));
  const dataIndex = lines.findIndex((line) => line.startsWith("data:"));
  const idIndex = lines.findIndex((line) => line.startsWith("id:"));

  const endIndex = (index: number) => {
    const targets = [eventIndex, dataIndex, idIndex, lines.length].filter(
      (current) => current > index,
    );
    return Math.min(...targets);
  };

  if (eventIndex === -1 || dataIndex === -1 || idIndex === -1) {
    console.error("Missing SSE fields in event:", text);
    throw new Error(
      `Failed to parse SSE event - missing fields. Event: ${text.slice(0, 100)}...`,
    );
  }

  const event = lines.slice(eventIndex, endIndex(eventIndex)).join("\n");
  const data = lines.slice(dataIndex, endIndex(dataIndex)).join("\n");
  const id = lines.slice(idIndex, endIndex(idIndex)).join("\n");

  const dataContent = data.slice("data:".length).trim();

  try {
    const parsedData = JSON.parse(dataContent) as SSEEvent;
    return {
      id: id.slice("id:".length).trim(),
      event: event.slice("event:".length).trim(),
      data: parsedData,
    };
  } catch (error) {
    console.error("JSON parse error:", error);
    console.error("Data content:", dataContent);
    console.error("Full event text:", text);
    throw new Error(
      `Failed to parse SSE event JSON: ${error}. Data: ${dataContent.slice(0, 100)}...`,
    );
  }
};

let isInitialized = false;

export const useServerEvents = () => {
  const queryClient = useQueryClient();
  const setAliveTasks = useSetAtom(aliveTasksAtom);

  const listener = useCallback(async () => {
    console.log("listening to events");
    const response = await honoClient.api.events.state_changes.$get();

    if (!response.ok) {
      throw new Error("Failed to fetch events");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Failed to get reader");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Add new chunk to buffer
      buffer += decoder.decode(value, { stream: true });

      // Process complete events (separated by \n\n)
      const eventBoundary = "\n\n";
      let boundaryIndex;

      while ((boundaryIndex = buffer.indexOf(eventBoundary)) !== -1) {
        const eventText = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + eventBoundary.length);

        if (eventText.trim().length > 0) {
          try {
            const event = parseSSEEvent(eventText);
            console.log("data", event);

            if (event.data.type === "project_changed") {
              await queryClient.invalidateQueries({
                queryKey: projetsQueryConfig.queryKey,
              });
            }

            if (event.data.type === "session_changed") {
              await queryClient.invalidateQueries({ queryKey: ["sessions"] });
            }

            if (event.data.type === "task_changed") {
              setAliveTasks(event.data.data);
            }
          } catch (error) {
            console.error(
              "Failed to parse SSE event:",
              error,
              "Event text:",
              eventText,
            );
          }
        }
      }
    }
  }, [queryClient, setAliveTasks]);

  useEffect(() => {
    if (isInitialized === false) {
      void listener()
        .then(() => {
          console.log("registered events listener");
          isInitialized = true;
        })
        .catch((error) => {
          console.error("failed to register events listener", error);
          isInitialized = true;
        });
    }
  }, [listener]);
};
