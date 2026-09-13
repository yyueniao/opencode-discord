import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js'
import type { DiscordMessageService } from '../../application/discord-message-service.js'
import type { SessionRuntimeRegistry } from '../../application/session-runtime-registry.js'
import { DiscordMessaging } from './messaging.js'
import type { OpencodeEventStream } from '../event-stream.js'
import type { Logger } from '../logger.js'
import type { OpencodeServer } from '../opencode-server.js'
import type { Database } from '../persistence.js'

export class DiscordBot {
  constructor(
    private readonly messages: DiscordMessageService,
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
    void this.opencode.ensure().catch((error: unknown) => {
      this.logger.error('Failed to start OpenCode server:', error)
    })

    client.on(Events.ClientReady, (readyClient) => {
      this.logger.log(`Logged in as ${readyClient.user.tag}`)
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
}
