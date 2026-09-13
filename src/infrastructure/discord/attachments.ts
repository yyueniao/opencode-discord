import fs from 'node:fs'
import path from 'node:path'
import type { Message } from 'discord.js'
import type { FileAttachment } from '../../domain/incoming-prompt.js'
import type { AppConfig } from '../config.js'
import type { Logger } from '../logger.js'

const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
]

const TEXT_ATTACHMENT_INLINE_LIMIT_BYTES = 64 * 1024

export class AttachmentService {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async getText(message: Message): Promise<string> {
    const textAttachments = Array.from(message.attachments.values()).filter(
      (attachment) => isTextMimeType(attachment.contentType),
    )
    if (textAttachments.length === 0) return ''

    const attachmentsDir = path.join(this.config.getDataDir(), 'attachments')
    fs.mkdirSync(attachmentsDir, { recursive: true })

    const textContents = await Promise.all(
      textAttachments.map(async (attachment) => {
        try {
          const response = await fetch(attachment.url)
          if (!response.ok) {
            return `<attachment name="${attachment.name}" error="Failed to fetch: ${response.status}" />`
          }
          const buffer = Buffer.from(await response.arrayBuffer())
          const savedPath = path.join(
            attachmentsDir,
            `${attachment.id}-${safeAttachmentBasename(attachment.name)}`,
          )
          await fs.promises.writeFile(savedPath, buffer)
          if (buffer.length > TEXT_ATTACHMENT_INLINE_LIMIT_BYTES) {
            return `<attachment name="${attachment.name}" path="${savedPath}" large="true">\nThis file is large. Read the local path.\n</attachment>`
          }
          return `<attachment name="${attachment.name}" path="${savedPath}">\n${buffer.toString('utf8')}\n</attachment>`
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          this.logger.error(`Failed to fetch text attachment ${attachment.name}:`, reason)
          return `<attachment name="${attachment.name}" error="${reason}" />`
        }
      }),
    )
    return textContents.join('\n\n')
  }

  async getFiles(message: Message): Promise<FileAttachment[]> {
    const fileAttachments = Array.from(message.attachments.values()).filter(
      (attachment) => {
        const contentType = attachment.contentType || ''
        return contentType.startsWith('image/') || contentType === 'application/pdf'
      },
    )
    if (fileAttachments.length === 0) return []

    const results = await Promise.all(
      fileAttachments.map(async (attachment): Promise<FileAttachment | null> => {
        try {
          const response = await fetch(attachment.url)
          if (!response.ok) {
            this.logger.error(`Failed to fetch attachment ${attachment.name}: ${response.status}`)
            return null
          }
          const rawBuffer = Buffer.from(await response.arrayBuffer())
          const mime = attachment.contentType || 'application/octet-stream'
          return {
            type: 'file',
            mime,
            filename: attachment.name,
            url: `data:${mime};base64,${rawBuffer.toString('base64')}`,
            sourceUrl: attachment.url,
          }
        } catch (error) {
          this.logger.error(`Error downloading attachment ${attachment.name}:`, error)
          return null
        }
      }),
    )
    return results.filter((item): item is FileAttachment => item !== null)
  }
}

function isTextMimeType(contentType: string | null): boolean {
  if (!contentType) return false
  if (contentType.startsWith('text/')) return true
  return TEXT_MIME_TYPES.includes(contentType)
}

function safeAttachmentBasename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}
