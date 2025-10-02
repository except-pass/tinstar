import { atom } from "jotai";

export type CurrentSessionState = {
  sessionId: string;
  projectId: string;
} | null;

export const currentSessionAtom = atom<CurrentSessionState>(null);
