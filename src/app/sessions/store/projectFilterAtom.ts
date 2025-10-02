import { atom } from "jotai";

export type ProjectFilterState = {
  selectedProjectIds: Set<string>;
  showAll: boolean;
};

export const projectFilterAtom = atom<ProjectFilterState>({
  selectedProjectIds: new Set<string>(),
  showAll: true,
});