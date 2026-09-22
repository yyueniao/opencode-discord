import type { ChannelProject } from './channel-project.js'
import type { ModelSelection } from './model-selection.js'

export interface ChannelProjectRepository {
  findByChannelId(channelId: string): Promise<ChannelProject | undefined>
  save(project: ChannelProject): Promise<void>
  delete(channelId: string): Promise<boolean>
  list(): Promise<ChannelProject[]>
}

export interface ThreadSessionRepository {
  findSessionId(threadId: string): Promise<string | undefined>
  save(threadId: string, sessionId: string): Promise<void>
}

export interface PartMessageRepository {
  save(input: { partId: string; messageId: string; threadId: string }): Promise<void>
  exists(partId: string): Promise<boolean>
}

export interface ModelSelectionRepository {
  get(): Promise<ModelSelection | undefined>
  save(selection: ModelSelection): Promise<void>
}
