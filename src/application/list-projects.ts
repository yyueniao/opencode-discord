import type { ChannelProject } from '../domain/channel-project.js'
import type { ChannelProjectRepository } from '../domain/repositories.js'

export class ListProjects {
  constructor(private readonly channelProjects: ChannelProjectRepository) {}

  async execute(): Promise<ChannelProject[]> {
    return this.channelProjects.list()
  }
}
