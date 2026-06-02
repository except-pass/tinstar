import { load as parseYaml } from 'js-yaml'

export interface Hand {
  name: string
  description: string
  cliTemplate: string
  prompt: string
  /**
   * Optional persistent persona. When set, this is the system prompt
   * (re-injected on /start so it survives restart and `/clear`) and `prompt`
   * becomes a one-shot intro fired as the first user message. When absent,
   * `prompt` itself is the persona.
   */
  systemPrompt?: string
}

/**
 * Parse a hand definition file (markdown with YAML frontmatter).
 * Returns null if parsing fails or required fields are missing.
 */
export function parseHandFile(content: string): Hand | null {
  try {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!frontmatterMatch) return null

    const frontmatter = parseYaml(frontmatterMatch[1]!) as Record<string, unknown>
    const prompt = frontmatterMatch[2]!.trim()

    const name = frontmatter.name as string
    if (!name) return null

    return {
      name,
      description: (frontmatter.description as string) ?? '',
      cliTemplate: (frontmatter.cliTemplate as string) ?? 'Claude (multi-agent)',
      prompt,
      ...(frontmatter.systemPrompt ? { systemPrompt: frontmatter.systemPrompt as string } : {}),
    }
  } catch {
    return null
  }
}
