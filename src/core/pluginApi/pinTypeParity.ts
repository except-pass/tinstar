// Compile-time guard: fails `tsc` if the plugin-api duplicates of Pin/PinSet/
// PinContext drift from the host domain source of truth (src/domain/pinSet.ts).
// No runtime effect. Keep both definitions structurally identical.
import type { Pin as DomainPin, PinSet as DomainPinSet, PinContext as DomainPinContext } from '../../domain/pinSet'
import type { Pin as PluginPin, PinSet as PluginPinSet, PinContext as PluginPinContext } from '@tinstar/plugin-api'

// Bidirectional assignability — both directions must hold for structural identity.
const _p1: PluginPin = {} as DomainPin; const _p2: DomainPin = {} as PluginPin
const _s1: PluginPinSet = {} as DomainPinSet; const _s2: DomainPinSet = {} as PluginPinSet
const _c1: PluginPinContext = {} as DomainPinContext; const _c2: DomainPinContext = {} as PluginPinContext
void _p1; void _p2; void _s1; void _s2; void _c1; void _c2
