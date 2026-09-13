export type FileAttachment = {
  type: 'file'
  mime: string
  filename?: string
  url: string
  sourceUrl?: string
}

export class IncomingPrompt {
  constructor(
    readonly text: string,
    readonly images: FileAttachment[] = [],
  ) {}

  isEmpty(): boolean {
    return !this.text.trim() && this.images.length === 0
  }

  withImagePaths(): string {
    if (this.images.length === 0) return this.text
    const listed = this.images
      .map((img) => `- ${img.sourceUrl || img.filename}`)
      .join('\n')
    return `${this.text}\n\n**The following images are already included in this message as inline content (do not use Read tool on these):**\n${listed}`
  }
}
