import { handle } from "hono/vercel";
import { honoApp } from "../../../server/hono/app";
import { routes } from "../../../server/hono/route";
import { ensureTinstarDirectories } from "../../../server/init/ensureTinstarDirs";

// Best-effort ensure runtime directories exist at boot time
await ensureTinstarDirectories();
routes(honoApp);

export const GET = handle(honoApp);
export const POST = handle(honoApp);
export const PUT = handle(honoApp);
export const PATCH = handle(honoApp);
export const DELETE = handle(honoApp);
