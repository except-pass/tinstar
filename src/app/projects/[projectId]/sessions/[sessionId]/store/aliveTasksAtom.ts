import { atom } from "jotai";
import type { SerializableAliveTask } from "../../../../../../server/service/claude-code/types";

export const aliveTasksAtom = atom<SerializableAliveTask[]>([]);
