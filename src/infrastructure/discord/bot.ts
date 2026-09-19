import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type Message,
} from 'discord.js'
import type { DiscordMessageService } from '../../application/discord-message-service.js'
import type { SlashCommands } from '../../presentation/slash-commands.js'
import type { SessionRuntimeRegistry } from '../../application/session-runtime-registry.js'
import { DiscordMessaging } from './messaging.js'
import type { OpencodeEventStream } from '../event-stream.js'
import type { Logger } from '../logger.js'
import type { OpencodeServer } from '../opencode-server.js'
import type { Database } from '../persistence.js'

export class DiscordBot {
  constructor(
    private readonly messages: DiscordMessageService,
    private readonly slashCommands: SlashCommands,
    private readonly runtimes: SessionRuntimeRegistry,
    private readonly eventStream: OpencodeEventStream,
    private readonly opencode: OpencodeServer,
    private readonly database: Database,
    private readonly logger: Logger,
  ) {}

  createClient(): Client {
    return new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
    })
  }

  async start({ token, client }: { token: string; client: Client }): Promise<void> {
    void this.slashCommands.ready().catch((error: unknown) => {
      this.logger.error('Failed to ready slash commands:', error)
    })
    void this.opencode.ensure().catch((error: unknown) => {
      this.logger.error('Failed to start OpenCode server:', error)
    })

    client.on(Events.ClientReady, (readyClient) => {
      this.logger.log(`Logged in as ${readyClient.user.tag}`)
      void this.registerSlashCommands(readyClient)
    })

    client.on(Events.GuildCreate, (guild) => {
      void guild.commands.set(this.slashCommands.definitions).catch((error: unknown) => {
        this.logger.error(`Failed to register slash commands in ${guild.id}:`, error)
      })
    })

    client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      try {
        await this.slashCommands.handle(interaction)
      } catch (error) {
        this.logger.error('InteractionCreate handler error:', error)
      }
    })

    client.on(Events.MessageCreate, async (message: Message) => {
      try {
        await this.messages.handle(client, message)
      } catch (error) {
        this.logger.error('MessageCreate handler error:', error)
        const errMsg = (error instanceof Error ? error.message : String(error)).slice(0, 1900)
        await message
          .reply({ content: `Error: ${errMsg}`, flags: DiscordMessaging.NOTIFY_FLAGS })
          .catch((sendError: unknown) => {
            this.logger.error('Failed to send handler error:', sendError)
          })
      }
    })

    client.on(Events.ThreadDelete, (thread) => {
      this.runtimes.dispose(thread.id)
    })

    client.on(Events.ThreadUpdate, (oldThread, newThread) => {
      if (newThread.archived && !oldThread.archived) {
        this.runtimes.dispose(newThread.id)
      }
    })

    client.on(Events.ChannelDelete, (channel) => {
      this.runtimes.dispose(channel.id)
      this.runtimes.disposeByChannelId(channel.id)
    })

    if (!client.isReady()) {
      await client.login(token)
    }

    const shutdown = async () => {
      this.logger.log('Shutting down')
      this.runtimes.disposeAll()
      this.eventStream.dispose()
      await this.opencode.stop()
      await this.database.close()
      client.destroy()
      process.exit(0)
    }
    process.once('SIGINT', () => {
      void shutdown()
    })
    process.once('SIGTERM', () => {
      void shutdown()
    })
  }

  private async registerSlashCommands(client: Client<true>): Promise<void> {
    try {
      await Promise.all(
        client.guilds.cache.map((guild) => guild.commands.set(this.slashCommands.definitions)),
      )
      this.logger.log('Registered /add-project')
    } catch (error) {
      this.logger.error('Failed to register slash commands:', error)
    }
  }
}
