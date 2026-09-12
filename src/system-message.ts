function escapePromptAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapePromptText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

export function getOpencodePromptContext({
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

export function getOpencodeSystemMessage({
  sessionId,
  channelId,
  guildId,
  threadId,
  channelTopic,
}: {
  sessionId: string
  channelId?: string
  guildId?: string
  threadId?: string
  channelTopic?: string
}): string {
  const topicContext = channelTopic?.trim()
    ? `\n\n<channel-topic>\n${channelTopic.trim()}\n</channel-topic>`
    : ''
  return `
The user is reading your messages from inside Discord.

Your current OpenCode session ID is: ${sessionId}${channelId ? `\nYour current Discord channel ID is: ${channelId}` : ''}${threadId ? `\nYour current Discord thread ID is: ${threadId}` : ''}${guildId ? `\nYour current Discord guild ID is: ${guildId}` : ''}
${topicContext}

Per-turn Discord metadata like the current user and Discord thread title is delivered in synthetic user message parts.

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
