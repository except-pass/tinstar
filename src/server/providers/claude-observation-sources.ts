import type { ProviderSource } from '../../domain/provider-capabilities'

export const CLAUDE_PROVIDER_ID = 'claude'
export const CLAUDE_ACCOUNT_REF = 'default'

export const CLAUDE_STATUSLINE_SOURCE: ProviderSource = {
  id: 'statusline',
  label: 'Claude Code statusline',
}

export const CLAUDE_PROMETHEUS_SOURCE: ProviderSource = {
  id: 'prometheus',
  label: 'Claude OTLP history via Prometheus',
}

export const CLAUDE_CONTEXT_SOURCE: ProviderSource = {
  id: 'control-protocol',
  label: 'Claude context control protocol',
}
