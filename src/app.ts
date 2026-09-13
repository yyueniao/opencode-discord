import { AddProject } from './application/add-project.js'
import { DiscordMessageService } from './application/discord-message-service.js'
import { ListProjects } from './application/list-projects.js'
import { MessagePreprocessor } from './application/message-preprocessor.js'
import { RemoveProject } from './application/remove-project.js'
import { SessionRuntimeRegistry } from './application/session-runtime-registry.js'
import { PartFormatter } from './domain/part-formatter.js'
import { PromptBuilder } from './domain/prompt-builder.js'
import { AppConfig } from './infrastructure/config.js'
import { AttachmentService } from './infrastructure/discord/attachments.js'
import { DiscordBot } from './infrastructure/discord/bot.js'
import { DiscordChannelProvisioner } from './infrastructure/discord/channel-provisioner.js'
import { DiscordMarkdown } from './infrastructure/discord/markdown.js'
import { MentionResolver } from './infrastructure/discord/mentions.js'
import { DiscordMessaging } from './infrastructure/discord/messaging.js'
import { EnvLoader } from './infrastructure/env-loader.js'
import { OpencodeEventStream } from './infrastructure/event-stream.js'
import { GitRepoScanner } from './infrastructure/git-repo-scanner.js'
import { Logger, LogFile, LogPrefix } from './infrastructure/logger.js'
import { OpencodeServer } from './infrastructure/opencode-server.js'
import {
  Database,
  SqliteChannelProjectRepository,
  SqlitePartMessageRepository,
  SqliteThreadSessionRepository,
} from './infrastructure/persistence.js'
import { Cli } from './presentation/cli.js'

export class App {
  readonly config = new AppConfig()
  readonly logFile = new LogFile(this.config)
  readonly envLoader = new EnvLoader()
  readonly gitRepos = new GitRepoScanner()
  readonly promptBuilder = new PromptBuilder()
  readonly partFormatter = new PartFormatter()
  readonly markdown = new DiscordMarkdown()
  readonly mentions = new MentionResolver()
  readonly provisioner = new DiscordChannelProvisioner(this.config)

  readonly cliLogger = new Logger(LogPrefix.CLI, this.logFile)
  readonly dbLogger = new Logger(LogPrefix.DB, this.logFile)
  readonly discordLogger = new Logger(LogPrefix.DISCORD, this.logFile)
  readonly opencodeLogger = new Logger(LogPrefix.OPENCODE, this.logFile)
  readonly sessionLogger = new Logger(LogPrefix.SESSION, this.logFile)

  readonly database = new Database(this.config, this.dbLogger)
  readonly channelProjects = new SqliteChannelProjectRepository(this.database)
  readonly threadSessions = new SqliteThreadSessionRepository(this.database)
  readonly partMessages = new SqlitePartMessageRepository(this.database)

  readonly opencode = new OpencodeServer(this.config, this.opencodeLogger)
  readonly eventStream = new OpencodeEventStream(this.opencode, this.sessionLogger)
  readonly messaging = new DiscordMessaging(this.markdown, this.discordLogger)
  readonly attachments = new AttachmentService(this.config, this.discordLogger)
  readonly preprocessor = new MessagePreprocessor(this.attachments, this.mentions)

  readonly runtimes = new SessionRuntimeRegistry({
    opencode: this.opencode,
    threadSessions: this.threadSessions,
    partMessages: this.partMessages,
    eventStream: this.eventStream,
    config: this.config,
    messaging: this.messaging,
    promptBuilder: this.promptBuilder,
    partFormatter: this.partFormatter,
    logger: this.sessionLogger,
    discordLogger: this.discordLogger,
  })

  readonly addProject = new AddProject(this.channelProjects, this.provisioner)
  readonly removeProject = new RemoveProject(this.channelProjects)
  readonly listProjects = new ListProjects(this.channelProjects)

  readonly messageService = new DiscordMessageService(
    this.channelProjects,
    this.threadSessions,
    this.runtimes,
    this.preprocessor,
    this.messaging,
    this.discordLogger,
  )

  readonly bot = new DiscordBot(
    this.messageService,
    this.runtimes,
    this.eventStream,
    this.opencode,
    this.database,
    this.discordLogger,
  )

  readonly cli = new Cli(this)

  constructor() {
    this.opencode.setOnReady(() => this.eventStream.restart())
  }

  async run(argv: string[]): Promise<void> {
    await this.cli.run(argv)
  }
}
