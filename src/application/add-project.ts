import fs from 'node:fs'
import path from 'node:path'
import { ChannelProject } from '../domain/channel-project.js'
import type { ChannelProjectRepository } from '../domain/repositories.js'
import type { DiscordChannelProvisioner } from '../infrastructure/discord/channel-provisioner.js'

export class AddProject {
  constructor(
    private readonly channelProjects: ChannelProjectRepository,
    private readonly provisioner: DiscordChannelProvisioner,
  ) {}

  async execute(directory: string): Promise<{ channelId: string; channelName: string; directory: string }> {
    const resolved = path.resolve(directory)
    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory does not exist: ${resolved}`)
    }

    const created = await this.provisioner.createProjectChannel(resolved)
    await this.channelProjects.save(
      new ChannelProject(created.channelId, resolved, created.guildId),
    )
    return {
      channelId: created.channelId,
      channelName: created.channelName,
      directory: resolved,
    }
  }
}
