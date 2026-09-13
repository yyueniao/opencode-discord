export class ChannelProject {
  constructor(
    readonly channelId: string,
    readonly directory: string,
    readonly guildId: string | null,
  ) {}
}
