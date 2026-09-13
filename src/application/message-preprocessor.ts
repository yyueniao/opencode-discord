import type { Message } from 'discord.js'
import { IncomingPrompt } from '../domain/incoming-prompt.js'
import type { AttachmentService } from '../infrastructure/discord/attachments.js'
import type { MentionResolver } from '../infrastructure/discord/mentions.js'

export class MessagePreprocessor {
  constructor(
    private readonly attachments: AttachmentService,
    private readonly mentions: MentionResolver,
  ) {}

  async preprocess(message: Message): Promise<IncomingPrompt> {
    const resolved = this.mentions.resolve(message)
    const textAttachments = await this.attachments.getText(message)
    const images = await this.attachments.getFiles(message)
    const text = [resolved, textAttachments].filter(Boolean).join('\n\n')
    return new IncomingPrompt(text, images)
  }
}
