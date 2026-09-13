import type { Part } from '@opencode-ai/sdk/v2'

export type SessionPartKind = 'text' | 'tool'

const HIDDEN_READONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'describe-media',
  'todoread',
]

export class SessionPart {
  static kind(part: { type: string }): SessionPartKind {
    return part.type === 'text' ? 'text' : 'tool'
  }

  static shouldLeadWithSeparator({
    previousKind,
    nextKind,
  }: {
    previousKind: SessionPartKind | undefined
    nextKind: SessionPartKind
  }): boolean {
    if (!previousKind) return false
    return previousKind === 'text' && nextKind === 'tool'
  }

  static isEssentialTool(part: Part): boolean {
    if (part.type !== 'tool') return false
    const hidden = HIDDEN_READONLY_TOOLS.some((name) => {
      return part.tool === name || part.tool.endsWith(`_${name}`)
    })
    if (hidden) return false
    if (part.tool === 'bash') {
      const hasSideEffect = part.state.input?.hasSideEffect
      return hasSideEffect !== false
    }
    return true
  }
}
