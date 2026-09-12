import { Lexer, type Tokens } from 'marked'

export function escapeBackticksInCodeBlocks(markdown: string): string {
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)
  let result = ''
  for (const token of tokens) {
    if (token.type === 'code') {
      const escapedCode = token.text.replace(/`/g, '\\`')
      result += '```' + (token.lang || '') + '\n' + escapedCode + '\n```\n'
    } else {
      result += token.raw
    }
  }
  return result
}

export function limitHeadingDepth(markdown: string, maxDepth = 3): string {
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)
  let result = ''
  for (const token of tokens) {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading
      if (heading.depth > maxDepth) {
        result += '#'.repeat(maxDepth) + ' ' + heading.text + '\n'
      } else {
        result += token.raw
      }
    } else {
      result += token.raw
    }
  }
  return result
}

type LineInfo = {
  text: string
  inCodeBlock: boolean
  lang: string
  isOpeningFence: boolean
  isClosingFence: boolean
}

export function splitMarkdownForDiscord({
  content,
  maxLength,
}: {
  content: string
  maxLength: number
}): string[] {
  if (content.length <= maxLength) return [content]

  const lexer = new Lexer()
  const tokens = lexer.lex(content)
  const lines: LineInfo[] = []
  const ensureNewlineBeforeCode = (): void => {
    const last = lines[lines.length - 1]
    if (!last || last.text.endsWith('\n')) return
    lines.push({
      text: '\n',
      inCodeBlock: false,
      lang: '',
      isOpeningFence: false,
      isClosingFence: false,
    })
  }

  for (const token of tokens) {
    if (token.type === 'code') {
      ensureNewlineBeforeCode()
      const lang = token.lang || ''
      lines.push({
        text: '```' + lang + '\n',
        inCodeBlock: false,
        lang,
        isOpeningFence: true,
        isClosingFence: false,
      })
      for (const codeLine of token.text.split('\n')) {
        lines.push({
          text: codeLine + '\n',
          inCodeBlock: true,
          lang,
          isOpeningFence: false,
          isClosingFence: false,
        })
      }
      lines.push({
        text: '```\n',
        inCodeBlock: false,
        lang: '',
        isOpeningFence: false,
        isClosingFence: true,
      })
      continue
    }
    const rawLines = token.raw.split('\n')
    for (let i = 0; i < rawLines.length; i++) {
      const isLast = i === rawLines.length - 1
      const text = isLast ? rawLines[i]! : rawLines[i]! + '\n'
      if (text) {
        lines.push({
          text,
          inCodeBlock: false,
          lang: '',
          isOpeningFence: false,
          isClosingFence: false,
        })
      }
    }
  }

  const chunks: string[] = []
  let currentChunk = ''
  let currentLang: string | null = null
  const closingFence = '```\n'

  const splitLongLine = (text: string, available: number, inCode: boolean): string[] => {
    const pieces: string[] = []
    let remaining = text
    while (remaining.length > available) {
      let splitAt = available
      if (!inCode) {
        const lastSpace = remaining.lastIndexOf(' ', available)
        if (lastSpace > available * 0.5) splitAt = lastSpace + 1
      }
      pieces.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt)
    }
    if (remaining) pieces.push(remaining)
    return pieces
  }

  const flush = (): void => {
    if (!currentChunk) return
    if (currentLang !== null) currentChunk += closingFence
    chunks.push(currentChunk)
    currentChunk = ''
  }

  for (const line of lines) {
    const openingFenceSize =
      currentChunk.length === 0 && (line.inCodeBlock || line.isOpeningFence)
        ? ('```' + line.lang + '\n').length
        : 0
    const lineLength =
      line.isOpeningFence && currentChunk.length === 0 ? 0 : line.text.length
    const activeFenceOverhead =
      currentLang !== null || openingFenceSize > 0 ? closingFence.length : 0
    const wouldExceed =
      currentChunk.length + openingFenceSize + lineLength + activeFenceOverhead >
      maxLength

    if (!wouldExceed) {
      currentChunk += line.text
      if (line.inCodeBlock || line.isOpeningFence) currentLang = line.lang
      else if (line.isClosingFence) currentLang = null
      continue
    }

    if (line.text.length > maxLength) {
      flush()
      currentLang = null
      const codeBlockOverhead = line.inCodeBlock
        ? ('```' + line.lang + '\n').length + closingFence.length
        : 0
      const availablePerChunk = Math.max(10, maxLength - codeBlockOverhead - 50)
      for (const piece of splitLongLine(line.text, availablePerChunk, line.inCodeBlock)) {
        chunks.push(
          line.inCodeBlock ? '```' + line.lang + '\n' + piece + closingFence : piece,
        )
      }
      continue
    }

    flush()
    if (line.isClosingFence && currentLang !== null) {
      currentLang = null
      continue
    }
    if (line.inCodeBlock || line.isOpeningFence) {
      currentChunk = '```' + line.lang + '\n'
      if (!line.isOpeningFence) currentChunk += line.text
      currentLang = line.lang
    } else {
      currentChunk = line.text
      currentLang = null
    }
  }

  flush()
  return chunks.length > 0 ? chunks : [content.slice(0, maxLength)]
}
