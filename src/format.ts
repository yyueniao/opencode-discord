import type { Part } from '@opencode-ai/sdk/v2'
import type { Embed, Message, Poll, TextChannel } from 'discord.js'
import { parsePatchFileCounts } from './patch.js'

function escapeInlineMarkdown(text: string): string {
  return text.replace(/([*_~|`\\])/g, '\\$1')
}

function normalizeWhitespace(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ')
}

export type SessionPartKind = 'text' | 'tool'

export function sessionPartKind(part: { type: string }): SessionPartKind {
  return part.type === 'text' ? 'text' : 'tool'
}

export function shouldLeadWithSeparator({
  previousKind,
  nextKind,
}: {
  previousKind: SessionPartKind | undefined
  nextKind: SessionPartKind
}): boolean {
  if (!previousKind) return false
  return previousKind === 'text' && nextKind === 'tool'
}

export function serializeEmbeds(embeds: Embed[]): string {
  if (embeds.length === 0) return ''
  const parts: string[] = []
  for (const embed of embeds) {
    const lines: string[] = []
    if (embed.author?.name) lines.push(`Author: ${embed.author.name}`)
    if (embed.title) lines.push(`Title: ${embed.title}`)
    if (embed.url) lines.push(`URL: ${embed.url}`)
    if (embed.description) lines.push(embed.description)
    for (const field of embed.fields) {
      lines.push(`${field.name}: ${field.value}`)
    }
    if (embed.footer?.text) lines.push(`Footer: ${embed.footer.text}`)
    if (lines.length > 0) {
      parts.push(`<embed>\n${lines.join('\n')}\n</embed>`)
    }
  }
  return parts.join('\n\n')
}

export function serializePoll(poll: Poll | null): string {
  if (!poll) return ''
  const lines: string[] = []
  if (poll.question.text) lines.push(`Question: ${poll.question.text}`)
  for (const [, answer] of poll.answers) {
    if (answer.text) lines.push(`- ${answer.text}`)
  }
  if (lines.length === 0) return ''
  return `<poll>\n${lines.join('\n')}\n</poll>`
}

export function serializeMessageSnapshots(
  snapshots: Message['messageSnapshots'],
): string {
  if (snapshots.size === 0) return ''
  const parts: string[] = []
  for (const [, snapshot] of snapshots) {
    const lines: string[] = []
    if (snapshot.content) lines.push(snapshot.content)
    if (snapshot.embeds.length > 0) {
      const embedText = serializeEmbeds(snapshot.embeds)
      if (embedText) lines.push(embedText)
    }
    if (lines.length > 0) {
      parts.push(
        `<forwarded-message>\n${lines.join('\n\n')}\n</forwarded-message>`,
      )
    }
  }
  return parts.join('\n\n')
}

export function resolveMentions(message: Message): string {
  let content = message.content || ''

  for (const [userId, user] of message.mentions.users) {
    const member = message.guild?.members.cache.get(userId)
    const displayName = member?.displayName || user.displayName || user.username
    content = content.replace(new RegExp(`<@!?${userId}>`, 'g'), `@${displayName}`)
  }
  for (const [roleId, role] of message.mentions.roles) {
    content = content.replace(new RegExp(`<@&${roleId}>`, 'g'), `@${role.name}`)
  }
  for (const [channelId, channel] of message.mentions.channels) {
    const name = 'name' in channel ? (channel as TextChannel).name : channelId
    content = content.replace(new RegExp(`<#${channelId}>`, 'g'), `#${name}`)
  }

  const extras = [
    serializeEmbeds(message.embeds),
    serializePoll(message.poll),
    serializeMessageSnapshots(message.messageSnapshots),
  ].filter(Boolean)
  if (extras.length > 0) {
    const joined = extras.join('\n\n')
    content = content ? `${content}\n\n${joined}` : joined
  }
  return content
}

const MAX_BASH_COMMAND_INLINE_LENGTH = 50

export function formatBashToolTitle({
  command,
  description,
  summary,
  stateTitle,
}: {
  command: string
  description?: string
  summary?: string
  stateTitle?: string
}): string {
  const label = description || summary
  if (!command && !label && !stateTitle) return ''

  const isSingleLine = !command.includes('\n')
  const firstMeaningfulLine =
    command
      .split('\n')
      .find((line) => line.trim().length > 0)
      ?.trimStart() ?? ''

  if (command && isSingleLine && command.length <= MAX_BASH_COMMAND_INLINE_LENGTH) {
    return ` _${escapeInlineMarkdown(command)}_`
  }
  if (label) {
    return ` _${escapeInlineMarkdown(label)}_`
  }
  if (firstMeaningfulLine.length > 0) {
    const needsTruncation = firstMeaningfulLine.length > MAX_BASH_COMMAND_INLINE_LENGTH
    const base = needsTruncation
      ? firstMeaningfulLine.slice(0, MAX_BASH_COMMAND_INLINE_LENGTH)
      : firstMeaningfulLine
    return ` _${escapeInlineMarkdown(base)}…_`
  }
  if (stateTitle) {
    return ` _${escapeInlineMarkdown(stateTitle)}_`
  }
  return ''
}

export function getToolSummaryText(part: Part): string {
  if (part.type !== 'tool') return ''

  if (part.tool === 'edit') {
    const filePath = (part.state.input?.filePath as string) || ''
    const newString = (part.state.input?.newString as string) || ''
    const oldString = (part.state.input?.oldString as string) || ''
    const added = newString.split('\n').length
    const removed = oldString.split('\n').length
    const fileName = filePath.split('/').pop() || ''
    return fileName
      ? `*${escapeInlineMarkdown(fileName)}* (+${added}-${removed})`
      : `(+${added}-${removed})`
  }

  if (part.tool === 'apply_patch') {
    const patchText = (part.state.input?.patchText as string) || ''
    if (!patchText) return ''
    return [...parsePatchFileCounts(patchText).entries()]
      .map(([filePath, { additions, deletions }]) => {
        const fileName = filePath.split('/').pop() || ''
        return fileName
          ? `*${escapeInlineMarkdown(fileName)}* (+${additions}-${deletions})`
          : `(+${additions}-${deletions})`
      })
      .join(', ')
  }

  if (part.tool === 'write') {
    const filePath = (part.state.input?.filePath as string) || ''
    const content = (part.state.input?.content as string) || ''
    const lines = content.split('\n').length
    const fileName = filePath.split('/').pop() || ''
    return fileName
      ? `*${escapeInlineMarkdown(fileName)}* (${lines} line${lines === 1 ? '' : 's'})`
      : `(${lines} line${lines === 1 ? '' : 's'})`
  }

  if (part.tool === 'webfetch') {
    const url = (part.state.input?.url as string) || ''
    const urlWithoutProtocol = url.replace(/^https?:\/\//, '')
    return urlWithoutProtocol ? `*${escapeInlineMarkdown(urlWithoutProtocol)}*` : ''
  }

  if (part.tool === 'read') {
    const filePath = (part.state.input?.filePath as string) || ''
    const fileName = filePath.split('/').pop() || ''
    return fileName ? `*${escapeInlineMarkdown(fileName)}*` : ''
  }

  if (part.tool === 'list') {
    const pathValue = (part.state.input?.path as string) || ''
    const dirName = pathValue.split('/').pop() || pathValue
    return dirName ? `*${escapeInlineMarkdown(dirName)}*` : ''
  }

  if (part.tool === 'glob' || part.tool === 'grep') {
    const pattern = (part.state.input?.pattern as string) || ''
    return pattern ? `*${escapeInlineMarkdown(pattern)}*` : ''
  }

  if (part.tool === 'bash' || part.tool === 'todoread' || part.tool === 'todowrite') {
    return ''
  }

  if (part.tool === 'task') return ''

  if (part.tool === 'skill') {
    const name = (part.state.input?.name as string) || ''
    return name ? `_${escapeInlineMarkdown(name)}_` : ''
  }

  if (!part.state.input) return ''

  const inputFields = Object.entries(part.state.input)
    .map(([key, value]) => {
      if (value === null || value === undefined) return null
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
      const normalized = normalizeWhitespace(stringValue)
      const truncatedValue =
        normalized.length > 50 ? normalized.slice(0, 50) + '…' : normalized
      return `${key}: ${truncatedValue}`
    })
    .filter(Boolean)

  if (inputFields.length === 0) return ''
  return `(${inputFields.join(', ')})`
}

export function formatTodoList(part: Part): string {
  if (part.type !== 'tool' || part.tool !== 'todowrite') return ''
  const todos =
    (part.state.input?.todos as {
      content: string
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
    }[]) || []
  const activeIndex = todos.findIndex((todo) => todo.status === 'in_progress')
  const activeTodo = todos[activeIndex]
  if (activeIndex === -1 || !activeTodo) return ''
  const digitWithPeriod = '⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛'
  const todoNumber = activeIndex + 1
  const num =
    todoNumber <= 20 ? digitWithPeriod[todoNumber - 1] : `${todoNumber}.`
  const content =
    activeTodo.content.charAt(0).toLowerCase() + activeTodo.content.slice(1)
  return `${num} **${escapeInlineMarkdown(content)}**`
}

export function formatTaskToolTitle(
  part: Extract<Part, { type: 'tool' }>,
): string {
  if (part.tool !== 'task' || part.state.status !== 'running') return ''
  const description = part.state.input?.description
  const stateTitle = part.state.title
  const title =
    typeof description === 'string' && description
      ? description
      : typeof stateTitle === 'string'
        ? stateTitle
        : ''
  if (!title) return ''
  const subagentType = part.state.input?.subagent_type
  const agent = typeof subagentType === 'string' ? subagentType : 'task'
  return `┣ ${escapeInlineMarkdown(agent)} **${escapeInlineMarkdown(title)}**`
}

export function formatPart(part: Part, prefix?: string): string {
  const pfx = prefix ? `${prefix} ⋅ ` : ''

  if (part.type === 'text') {
    const text = part.text?.trim()
    if (!text) return ''
    if (prefix) return `${pfx}${text}`
    return text
  }

  if (part.type === 'reasoning') {
    if (!part.text?.trim()) return ''
    return `┣ ${pfx}thinking`
  }

  if (part.type === 'file') {
    return prefix
      ? `📄 ${pfx}${part.filename || 'File'}`
      : `📄 ${part.filename || 'File'}`
  }

  if (
    part.type === 'step-start' ||
    part.type === 'step-finish' ||
    part.type === 'patch'
  ) {
    return ''
  }

  if (part.type === 'agent') {
    return `┣ ${pfx}agent ${part.id}`
  }

  if (part.type === 'snapshot') {
    return `┣ ${pfx}snapshot ${part.snapshot}`
  }

  if (part.type === 'tool') {
    if (part.tool === 'todowrite') {
      const formatted = formatTodoList(part)
      return prefix && formatted ? `┣ ${pfx}${formatted}` : formatted
    }

    if (part.tool === 'question' || part.tool === 'task') {
      return ''
    }

    if (part.state.status === 'pending') {
      if (part.tool !== 'bash') return ''
      const command = (part.state.input?.command as string) || ''
      const description = (part.state.input?.description as string) || ''
      const summary = (part.state.input?.summary as string) || ''
      const toolTitle = formatBashToolTitle({ command, description, summary })
      return `┣ ${pfx}bash${toolTitle}`
    }

    const summaryText = getToolSummaryText(part)
    const stateTitle = 'title' in part.state ? part.state.title : undefined

    let toolTitle = ''
    if (part.state.status === 'error') {
      toolTitle = part.state.error || 'error'
    } else if (part.tool === 'bash') {
      const command = (part.state.input?.command as string) || ''
      const description = (part.state.input?.description as string) || ''
      const summary = (part.state.input?.summary as string) || ''
      const formatted = formatBashToolTitle({
        command,
        description,
        summary,
        stateTitle,
      })
      toolTitle = formatted.startsWith(' ') ? formatted.slice(1) : formatted
    } else if (stateTitle) {
      toolTitle = `_${escapeInlineMarkdown(stateTitle)}_`
    }

    const icon = (() => {
      if (part.state.status === 'error') return '⨯'
      if (
        part.tool === 'edit' ||
        part.tool === 'write' ||
        part.tool === 'apply_patch'
      ) {
        return '◼︎'
      }
      return '┣'
    })()
    const toolParts = [part.tool, toolTitle, summaryText].filter(Boolean).join(' ')
    return `${icon} ${pfx}${toolParts}`
  }

  return ''
}

const HIDDEN_READONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'describe-media',
  'todoread',
]

export function isEssentialToolPart(part: Part): boolean {
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
