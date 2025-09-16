import { hc } from "hono/client";
import type { RouteType } from "../../server/hono/route";

export const honoClient = hc<RouteType>(
  typeof window === "undefined"
    ? // biome-ignore lint/complexity/useLiteralKeys: TypeScript restriction
      `http://localhost:${process.env["PORT"] ?? 3000}/`
    : "/",
);
