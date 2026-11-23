import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

type Input = z.ZodTypeAny | z.ZodRawShape

function inputSchema(input: Input, root?: { branch: string; fields: readonly string[] }): Tool['inputSchema'] {
  const schema = input instanceof z.ZodType ? input : z.object(input)
  // The SDK normalizes top-level unions to an empty object and its converter
  // emits shared-property references. Publish directly from the original Zod
  // schema instead; SDK registration still owns tools/call input validation.
  const { $schema: _dialect, ...json } = zodToJsonSchema(schema, { $refStrategy: 'none', pipeStrategy: 'input' })
  if (schema instanceof z.ZodDiscriminatedUnion && 'anyOf' in json) {
    const { anyOf, ...rest } = json
    const branches = anyOf as Array<{ properties: NonNullable<Tool['inputSchema']['properties']>; required?: string[] }>
    const selectedIndex = schema.options.findIndex((option: z.AnyZodObject) => option.shape[schema.discriminator].value === root?.branch)
    const selected = branches[selectedIndex]
    const properties = Object.fromEntries(Object.entries(selected?.properties ?? {}).filter(([name]) => root?.fields.includes(name)).map(([name, property]) => {
      // Root properties are ANDed with oneOf. Advertise every branch's
      // accepted values here so a narrower branch cannot veto another one.
      const variants = new Map(branches.flatMap(branch => {
        const value = branch.properties[name]
        return value === undefined ? [] : [[JSON.stringify(value), value] as const]
      }))
      return [name, variants.size > 1 ? { anyOf: [...variants.values()] } : property]
    }))
    properties[schema.discriminator] = { type: 'string', enum: schema.options.map((option: z.AnyZodObject) => option.shape[schema.discriminator].value) }
    const required = branches[0]?.required?.filter(name => branches.every(branch => branch.required?.includes(name))) ?? []
    return { ...rest, type: 'object', properties, ...(root ? { required } : {}), oneOf: anyOf }
  }
  return { ...json, type: 'object' }
}

/** One registration path for the catalog and the SDK's authoritative handlers. */
export function createToolCatalog(server: McpServer) {
  const tools: Tool[] = []
  return {
    registerTool<Args extends Input>(name: string, config: Pick<Tool, 'description' | 'annotations'> & { inputSchema: Args; discoverySchema?: Input }, handler: ToolCallback<Args>, root?: { branch: string; fields: readonly string[] }) {
      const registered = server.registerTool(name, config, handler)
      // No tool supports task execution. Omission also keeps the catalog valid
      // for 2026-07-28, whose Tool shape removed the legacy execution field.
      tools.push({ name, description: config.description, inputSchema: inputSchema(config.discoverySchema ?? config.inputSchema, root), annotations: config.annotations })
      return registered
    },
    publish() {
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
    },
  }
}

export type ToolRegistrar = Pick<ReturnType<typeof createToolCatalog>, 'registerTool'>
