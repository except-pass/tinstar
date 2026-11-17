import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

type Input = z.ZodTypeAny | z.ZodRawShape

function inputSchema(input: Input, rootArguments: readonly string[]): Tool['inputSchema'] {
  const schema = input instanceof z.ZodType ? input : z.object(input)
  // The SDK normalizes top-level unions to an empty object and its converter
  // emits shared-property references. Publish directly from the original Zod
  // schema instead; SDK registration still owns tools/call input validation.
  const { $schema: _dialect, ...json } = zodToJsonSchema(schema, { $refStrategy: 'none', pipeStrategy: 'input' })
  if (schema instanceof z.ZodDiscriminatedUnion && 'anyOf' in json) {
    const { anyOf, ...rest } = json
    // Some clients build call arguments from the root properties. Expose every
    // argument there while oneOf still defines each operation's exact shape.
    const branches = anyOf as Array<{ properties: NonNullable<Tool['inputSchema']['properties']>; required?: string[] }>
    const definitions = new Map<string, Map<string, object>>()
    for (const branch of branches) for (const [name, definition] of Object.entries(branch.properties)) {
      if (!rootArguments.includes(name)) continue
      const variants = definitions.get(name) ?? new Map<string, object>()
      variants.set(JSON.stringify(definition), definition)
      definitions.set(name, variants)
    }
    const properties = Object.fromEntries([...definitions].map(([name, definitions]) => {
      const variants = [...definitions.values()]
      return [name, variants.length === 1 ? variants[0]! : { anyOf: variants }]
    }))
    properties[schema.discriminator] = { type: 'string', enum: schema.options.map((option: z.AnyZodObject) => option.shape[schema.discriminator].value) }
    const required = branches[0]?.required?.filter(name => branches.every(branch => branch.required?.includes(name))) ?? []
    return { ...rest, type: 'object', properties, ...(rootArguments.length ? { required } : {}), oneOf: anyOf }
  }
  return { ...json, type: 'object' }
}

/** One registration path for the catalog and the SDK's authoritative handlers. */
export function createToolCatalog(server: McpServer) {
  const tools: Tool[] = []
  return {
    registerTool<Args extends Input>(name: string, config: Pick<Tool, 'description' | 'annotations'> & { inputSchema: Args }, handler: ToolCallback<Args>, rootArguments: readonly string[] = []) {
      const registered = server.registerTool(name, config, handler)
      // No tool supports task execution. Omission also keeps the catalog valid
      // for 2026-07-28, whose Tool shape removed the legacy execution field.
      tools.push({ name, description: config.description, inputSchema: inputSchema(config.inputSchema, rootArguments), annotations: config.annotations })
      return registered
    },
    publish() {
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
    },
  }
}

export type ToolRegistrar = Pick<ReturnType<typeof createToolCatalog>, 'registerTool'>
