import type { ChannelProject } from '../domain/channel-project.js'
import type { Memory } from '../domain/memory.js'
import type { ChannelProjectRepository, MemoryRepository } from '../domain/repositories.js'

export class ListMemories {
  constructor(
    private readonly memories: MemoryRepository,
    private readonly channelProjects: ChannelProjectRepository,
  ) {}

  async forChannel(
    channelId: string,
  ): Promise<{ project: ChannelProject; memories: Memory[] } | undefined> {
    const project = await this.channelProjects.findByChannelId(channelId)
    if (!project) return undefined
    return {
      project,
      memories: await this.memories.list(project.directory),
    }
  }

  async projects(): Promise<ChannelProject[]> {
    return this.channelProjects.list()
  }
}
