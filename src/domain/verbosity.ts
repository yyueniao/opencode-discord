export type VerbosityLevel = 'text_only' | 'text_and_essential_tools' | 'tools_and_text'

export class Verbosity {
  static readonly TextOnly = new Verbosity('text_only')
  static readonly TextAndEssentialTools = new Verbosity('text_and_essential_tools')
  static readonly ToolsAndText = new Verbosity('tools_and_text')

  private constructor(readonly level: VerbosityLevel) {}

  static parse(value: string | undefined): Verbosity {
    if (value === 'text_only') return Verbosity.TextOnly
    if (value === 'text_and_essential_tools') return Verbosity.TextAndEssentialTools
    if (value === 'tools_and_text') return Verbosity.ToolsAndText
    return Verbosity.TextAndEssentialTools
  }

  get isTextOnly(): boolean {
    return this.level === 'text_only'
  }

  get isTextAndEssentialTools(): boolean {
    return this.level === 'text_and_essential_tools'
  }

  get isToolsAndText(): boolean {
    return this.level === 'tools_and_text'
  }
}
