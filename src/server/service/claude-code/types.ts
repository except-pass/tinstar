import type { Query } from "@anthropic-ai/claude-code";
import type { MessageGenerator, OnMessage } from "./createMessageGenerator";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export type ModelType = "default" | "sonnet" | "opus" | "opusplan";
type BaseClaudeCodeTask = {
  id: string;
  projectId: string;
  baseSessionId?: string | undefined; // undefined = new session
  cwd: string;
  generateMessages: MessageGenerator;
  setNextMessage: (message: string) => void;
  resolveFirstMessage: () => void;
  setFirstMessagePromise: () => void;
  awaitFirstMessage: () => Promise<void>;
  onMessageHandlers: OnMessage[];
  query?: Query;
  currentPermissionMode?: PermissionMode;
  model?: ModelType;
  runPurpose?: string;
};

export type PendingClaudeCodeTask = BaseClaudeCodeTask & {
  status: "pending";
};

export type RunningClaudeCodeTask = BaseClaudeCodeTask & {
  status: "running";
  sessionId: string;
  userMessageId: string;
  abortController: AbortController;
};

export type PausedClaudeCodeTask = BaseClaudeCodeTask & {
  status: "paused";
  sessionId: string;
  userMessageId: string;
  abortController: AbortController;
};

type CompletedClaudeCodeTask = BaseClaudeCodeTask & {
  status: "completed";
  sessionId: string;
  userMessageId: string;
  abortController: AbortController;
  resolveFirstMessage: () => void;
};

type FailedClaudeCodeTask = BaseClaudeCodeTask & {
  status: "failed";
  sessionId?: string;
  userMessageId?: string;
  abortController?: AbortController;
};

export type ClaudeCodeTask =
  | RunningClaudeCodeTask
  | PausedClaudeCodeTask
  | CompletedClaudeCodeTask
  | FailedClaudeCodeTask;

export type AliveClaudeCodeTask = RunningClaudeCodeTask | PausedClaudeCodeTask;

export type SerializableAliveTask = Pick<
  AliveClaudeCodeTask,
  | "id"
  | "status"
  | "sessionId"
  | "userMessageId"
  | "currentPermissionMode"
  | "model"
  | "runPurpose"
>;
