import type { Embed, Message, Poll, TextChannel } from 'discord.js'

export class MentionResolver {
  resolve(message: Message): string {
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
}

function serializeEmbeds(embeds: Embed[]): string {
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

function serializePoll(poll: Poll | null): string {
  if (!poll) return ''
  const lines: string[] = []
  if (poll.question.text) lines.push(`Question: ${poll.question.text}`)
  for (const [, answer] of poll.answers) {
    if (answer.text) lines.push(`- ${answer.text}`)
  }
  if (lines.length === 0) return ''
  return `<poll>\n${lines.join('\n')}\n</poll>`
}

function serializeMessageSnapshots(snapshots: Message['messageSnapshots']): string {
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
