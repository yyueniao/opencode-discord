import type { Memory } from './memory.js'

export class PromptBuilder {
  context({
    username,
    userId,
    sourceMessageId,
    sourceThreadId,
    threadName,
    repliedMessage,
  }: {
    username?: string
    userId?: string
    sourceMessageId?: string
    sourceThreadId?: string
    threadName?: string
    repliedMessage?: { authorUsername?: string; text: string }
  }): string {
    const userAttrs = [
      ...(username ? [` name="${escapePromptAttribute(username)}"`] : []),
      ...(userId ? [` user-id="${escapePromptAttribute(userId)}"`] : []),
      ...(sourceMessageId
        ? [` message-id="${escapePromptAttribute(sourceMessageId)}"`]
        : []),
      ...(sourceThreadId
        ? [` thread-id="${escapePromptAttribute(sourceThreadId)}"`]
        : []),
      ...(threadName
        ? [` thread-name="${escapePromptAttribute(threadName)}"`]
        : []),
    ].join('')
    const repliedMessageXml = repliedMessage
      ? `This message was a reply to message

<replied-message${repliedMessage.authorUsername ? ` author="${escapePromptAttribute(repliedMessage.authorUsername)}"` : ''}>
${escapePromptText(repliedMessage.text)}
</replied-message>`
      : undefined
    const sections = [
      ...(userAttrs ? [`<discord-user${userAttrs} />`] : []),
      ...(repliedMessageXml ? [repliedMessageXml] : []),
    ]
    if (sections.length === 0) return ''
    return `${sections.join('\n\n')}\n`
  }

  systemMessage({
    sessionId,
    channelId,
    guildId,
    threadId,
    channelTopic,
    memories,
    memoryFilePath,
  }: {
    sessionId: string
    channelId?: string
    guildId?: string
    threadId?: string
    channelTopic?: string
    memories?: Memory[]
    memoryFilePath?: string
  }): string {
    const topicContext = channelTopic?.trim()
      ? `\n\n<channel-topic>\n${channelTopic.trim()}\n</channel-topic>`
      : ''
    return `
The user is reading your messages from inside Discord.

Your current OpenCode session ID is: ${sessionId}${channelId ? `\nYour current Discord channel ID is: ${channelId}` : ''}${threadId ? `\nYour current Discord thread ID is: ${threadId}` : ''}${guildId ? `\nYour current Discord guild ID is: ${guildId}` : ''}
${topicContext}

Per-turn Discord metadata like the current user and Discord thread title is delivered in synthetic user message parts.

${memoryInstructions({ memories, memoryFilePath })}

## discord formatting

Write Discord markdown. Text parts are posted as classic Discord content with no prefix.
Do not add emoji. Do not copy ┣, ◼︎, ⬦, or ⨯ prefixes; the bot adds those for tools and thinking.

## discord user mentions

Prefer Discord user IDs for mentions. Discord bots cannot ping by @name; use \`<@userId>\` in message text.
The current user's ID is available in the per-turn \`<discord-user ... user-id="..." />\` metadata.

## ending a turn

When your turn is done, the last line of the final reply MUST ping the current user and add a short summary of what just happened.
Use the Discord user ID from the per-turn \`<discord-user user-id="..." />\` metadata:

\`<@535922349652836367> tests passed\`

Rules:
- Ping only on the final reply of a completed turn, so Discord shows a red sidebar dot for finished sessions
- Keep the summary to one short sentence so it shows in the Discord notification
- Do not ping after tool output, mid-turn text, or if you are about to keep working
`.trim()
  }
}

function memoryInstructions({
  memories,
  memoryFilePath,
}: {
  memories?: Memory[]
  memoryFilePath?: string
}): string {
  if (!memoryFilePath) return ''
  const lines = (memories ?? []).map((memory) => {
    const name = memory.username || 'unknown'
    const userId = memory.userId ? ` user-id="${escapePromptAttribute(memory.userId)}"` : ''
    return `- ${name}${userId}: ${escapePromptText(memory.fact)}`
  })
  const body = lines.length > 0 ? lines.join('\n') : '(none yet)'
  return `
## project memories

Durable user facts and preferences persist across threads in this JSON file:
\`${memoryFilePath}\`

Current memories:
<project-memories>
${body}
</project-memories>

When you learn a lasting fact or preference about a user (style, constraints, names, decisions that should survive this thread), update that JSON file.
Use the Discord user ID from \`<discord-user user-id="..." />\`. Keep each fact one short sentence. Preserve existing memories unless they are wrong. Do not store secrets.

Schema:
{"memories":[{"userId":"<discord user id>","username":"<name>","fact":"<one sentence>"}]}
`.trim()
}

function escapePromptAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapePromptText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}
