import type { ChannelProjectRepository } from '../domain/repositories.js'

export class RemoveProject {
  constructor(private readonly channelProjects: ChannelProjectRepository) {}

  async execute(channelId: string): Promise<boolean> {
    return this.channelProjects.delete(channelId)
  }
}
