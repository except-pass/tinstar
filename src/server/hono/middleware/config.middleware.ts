import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { configSchema } from "../../config/config";
import { getConfigStorage } from "../../config/storage";
import type { HonoContext } from "../app";

export const configMiddleware = createMiddleware<HonoContext>(
  async (c, next) => {
    const configStorage = getConfigStorage();

    // Load base config from file storage
    const baseConfig = await configStorage.getConfig();

    // Check for cookie overrides
    const cookie = getCookie(c, "ccv-config");
    const cookieOverrides = (() => {
      try {
        return cookie ? JSON.parse(cookie) : {};
      } catch {
        return {};
      }
    })();

    // Merge base config with cookie overrides
    const finalConfig = configSchema.parse({
      ...baseConfig,
      ...cookieOverrides,
      // Don't allow commandPrefs to be overridden by cookies
      commandPrefs: baseConfig.commandPrefs,
    });

    // Set default cookie if none exists
    if (cookie === undefined) {
      setCookie(
        c,
        "ccv-config",
        JSON.stringify({
          hideNoUserMessageSession: true,
          unifySameTitleSession: true,
        }),
      );
    }

    c.set("config", finalConfig);

    await next();
  },
);
