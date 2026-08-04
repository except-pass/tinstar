export const DEFAULT_NATS_PORT = 4222

/** One broker URL for the host responder and every managed MCP client. */
export function natsBrokerUrl(
  env: NodeJS.ProcessEnv = process.env,
  defaultPort = DEFAULT_NATS_PORT,
): string {
  return env.NATS_URL
    ?? `nats://127.0.0.1:${parseInt(env.NATS_PORT ?? String(defaultPort), 10)}`
}
