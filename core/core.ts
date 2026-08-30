import { fetchwithRequestOptions } from "@continuedev/fetch";
import * as URI from "uri-js";
import { v4 as uuidv4 } from "uuid";

import { CompletionProvider } from "./autocomplete/CompletionProvider";
import {
  openedFilesLruCache,
  prevFilepaths,
} from "./autocomplete/util/openedFilesLruCache";
import { ConfigHandler } from "./config/ConfigHandler";
import { addModel, deleteModel } from "./config/util";
import { DevDataSqliteDb } from "./data/devdataSqlite";
import { DataLogger } from "./data/log";
import { CodebaseIndexer } from "./indexing/CodebaseIndexer";
import DocsService from "./indexing/docs/DocsService";
import { countTokens } from "./llm/countTokens";
import Lemonade from "./llm/llms/Lemonade";
import { fetchModels } from "./llm/fetchModels";
import Ollama from "./llm/llms/Ollama";
import { EditAggregator } from "./nextEdit/context/aggregateEdits";
import { createNewPromptFileV2 } from "./promptFiles/createNewPromptFile";
import { runLifecycleHooks, runToolHooks } from "./hooks/toolHooks";
import {
  bindBrokerLifecycleBinding,
  emitBrokerLifecycle,
  startBrokerLifecycleBinding,
} from "./hooks/brokerLifecycleBridge";
import { HookSessionLedger } from "./hooks/sessionLedger";
import { callTool } from "./tools/callTool";
import { safeParseToolCallArgs } from "./tools/parseArgs";
import { ChatDescriber } from "./util/chatDescriber";
import { compactConversation } from "./util/conversationCompaction";
import { GlobalContext } from "./util/GlobalContext";
import historyManager from "./util/history";
import {
  editConfigFile,
  getSessionFilePath,
  migrateV1DevDataFiles,
} from "./util/paths";

import {
  isProcessBackgrounded,
  killTerminalProcess,
  markProcessAsBackgrounded,
} from "./util/processTerminalStates";
import { getSymbolsForManyFiles } from "./util/treeSitter";
import { TTS } from "./util/tts";

import {
  CompleteOnboardingPayload,
  ChatMessage,
  ContextItemId,
  ContextItemWithId,
  IdeSettings,
  ModelDescription,
  Position,
  RangeInFile,
  ToolCall,
  type ContextItem,
  type IDE,
  type PromptLog,
} from ".";

import { ConfigYaml } from "@continuedev/config-yaml";
import { getDiffFn, GitDiffCache } from "./autocomplete/snippets/gitDiffCache";
import { stringifyMcpPrompt } from "./commands/slash/mcpSlashCommand";
import { createNewAssistantFile } from "./config/createNewAssistantFile";
import {
  isColocatedRulesFile,
  isContinueAgentConfigFile,
  isContinueConfigRelatedUri,
} from "./config/loadLocalAssistants";
import { CodebaseRulesCache } from "./config/markdown/loadCodebaseRules";
import {
  setupLocalConfig,
  setupProviderConfig,
  setupQuickstartConfig,
} from "./config/onboarding";
import {
  createNewGlobalRuleFile,
  createNewWorkspaceBlockFile,
} from "./config/workspace/workspaceBlocks";
import { MCPManagerSingleton } from "./context/mcp/MCPManagerSingleton";
import { performAuth, removeMCPAuth } from "./context/mcp/MCPOauth";
import { myersDiff } from "./diff/myers";
import { ApplyAbortManager } from "./edit/applyAbortManager";
import { streamDiffLines } from "./edit/streamDiffLines";
import { shouldIgnore } from "./indexing/shouldIgnore";
import { walkDirCache } from "./indexing/walkDir";
import { LLMLogger } from "./llm/logger";
import { llmStreamChat } from "./llm/streamChat";
import { BeforeAfterDiff } from "./nextEdit/context/diffFormatting";
import { processSmallEdit } from "./nextEdit/context/processSmallEdit";
import { PrefetchQueue } from "./nextEdit/NextEditPrefetchQueue";
import { NextEditProvider } from "./nextEdit/NextEditProvider";
import type { FromCoreProtocol, ToCoreProtocol } from "./protocol";
import { OnboardingModes } from "./protocol/core";
import type { IMessenger, Message } from "./protocol/messenger";
import { ContinueError, ContinueErrorReason } from "./util/errors";
import { shareSession } from "./util/historyUtils";
import { Logger } from "./util/Logger.js";
import { fileURLToPath } from "node:url";

export class Core {
  configHandler: ConfigHandler;
  codeBaseIndexer: CodebaseIndexer;
  completionProvider: CompletionProvider;
  nextEditProvider: NextEditProvider;
  private docsService: DocsService;
  private globalContext = new GlobalContext();
  llmLogger = new LLMLogger();

  private messageAbortControllers = new Map<string, AbortController>();
  private activeHookSessions = new Map<string, string>();
  private readonly hookSessionLedger = new HookSessionLedger();
  private hookLifecycleReady: Promise<void> = Promise.resolve();
  private addMessageAbortController(id: string): AbortController {
    const controller = new AbortController();
    this.messageAbortControllers.set(id, controller);
    controller.signal.addEventListener("abort", () => {
      this.messageAbortControllers.delete(id);
    });
    return controller;
  }
  private abortById(messageId: string) {
    this.messageAbortControllers.get(messageId)?.abort();
  }

  invoke<T extends keyof ToCoreProtocol>(
    messageType: T,
    data: ToCoreProtocol[T][0],
  ): ToCoreProtocol[T][1] {
    return this.messenger.invoke(messageType, data);
  }

  send<T extends keyof FromCoreProtocol>(
    messageType: T,
    data: FromCoreProtocol[T][0],
    messageId?: string,
  ): string {
    return this.messenger.send(messageType, data, messageId);
  }

  // TODO: It shouldn't actually need an IDE type, because this can happen
  // through the messenger (it does in the case of any non-VS Code IDEs already)
  constructor(
    private readonly messenger: IMessenger<ToCoreProtocol, FromCoreProtocol>,
    private readonly ide: IDE,
  ) {
    try {
      // Ensure .continue directory is created
      migrateV1DevDataFiles();

      const ideInfoPromise = messenger.request("getIdeInfo", undefined);
      const ideSettingsPromise = messenger.request("getIdeSettings", undefined);
      this.configHandler = new ConfigHandler(this.ide, this.llmLogger);

      // A crash cannot run a shutdown hook. Reconcile the durable journal as
      // soon as the next host is available instead of silently losing SessionEnd.
      this.hookLifecycleReady = this.reconcileHookSessions();

      this.docsService = DocsService.createSingleton(
        this.configHandler,
        this.ide,
        this.messenger,
      );

      MCPManagerSingleton.getInstance().onConnectionsRefreshed = () => {
        void this.configHandler.reloadConfig("MCP Connections refreshed");

        // Refresh @mention dropdown submenu items for MCP providers
        const mcpManager = MCPManagerSingleton.getInstance();
        const mcpProviderNames = Array.from(mcpManager.connections.keys()).map(
          (mcpId) => `mcp-${mcpId}`,
        );

        if (mcpProviderNames.length > 0) {
          this.messenger.send("refreshSubmenuItems", {
            providers: mcpProviderNames,
          });
        }
      };

      this.codeBaseIndexer = new CodebaseIndexer(
        this.configHandler,
        this.ide,
        this.messenger,
        this.globalContext.get("indexingPaused"),
      );

      this.configHandler.onConfigUpdate((result) => {
        void (async () => {
          const serializedResult =
            await this.configHandler.getSerializedConfig();
          this.messenger.send("configUpdate", {
            result: serializedResult,
            profileId:
              this.configHandler.currentProfile?.profileDescription.id || null,
            profiles: this.configHandler.profileDescriptions,
          });

          if (await this.codeBaseIndexer.wasAnyOneIndexAdded()) {
            await this.codeBaseIndexer.refreshCodebaseIndex(
              await this.ide.getWorkspaceDirs(),
            );
          }

          // update additional submenu context providers registered via VSCode API
          const additionalProviders =
            this.configHandler.getAdditionalSubmenuContextProviders();
          if (additionalProviders.length > 0) {
            this.messenger.send("refreshSubmenuItems", {
              providers: additionalProviders,
            });
          }
        })();
      });

      // Dev Data Logger
      const dataLogger = DataLogger.getInstance();
      dataLogger.core = this;
      dataLogger.ideInfoPromise = ideInfoPromise;
      dataLogger.ideSettingsPromise = ideSettingsPromise;

      void ideSettingsPromise.then((ideSettings) => {
        // Index on initialization
        void this.ide.getWorkspaceDirs().then(async (dirs) => {
          // Respect pauseCodebaseIndexOnStart user settings
          if (ideSettings.pauseCodebaseIndexOnStart) {
            this.codeBaseIndexer.paused = true;
            void this.messenger.request("indexProgress", {
              progress: 0,
              desc: "Initial Indexing Skipped",
              status: "paused",
            });
            return;
          }

          // Check for disableIndexing to prevent race condition
          const { config } = await this.configHandler.loadConfig();
          if (!config || config.disableIndexing) {
            void this.messenger.request("indexProgress", {
              progress: 0,
              desc: "Indexing is disabled",
              status: "disabled",
            });
            return;
          }

          void this.codeBaseIndexer.refreshCodebaseIndex(dirs);
        });
      });

      const getLlm = async () => {
        const { config } = await this.configHandler.loadConfig();
        if (!config) {
          return undefined;
        }
        return config.selectedModelByRole.autocomplete ?? undefined;
      };
      this.completionProvider = new CompletionProvider(
        this.configHandler,
        ide,
        getLlm,
        (e) => {},
        (..._) => Promise.resolve([]),
      );

      const codebaseRulesCache = CodebaseRulesCache.getInstance();
      void codebaseRulesCache
        .refresh(ide)
        .catch((e) =>
          Logger.error("Failed to initialize colocated rules cache"),
        )
        .then(() => {
          void this.configHandler.reloadConfig(
            "Initial codebase rules post-walkdir/load reload",
          );
        });
      this.nextEditProvider = NextEditProvider.initialize(
        this.configHandler,
        ide,
        getLlm,
        (e) => {},
        (..._) => Promise.resolve([]),
        "fineTuned",
      );

      this.registerMessageHandlers(ideSettingsPromise);
    } catch (error) {
      Logger.error(error);
      throw error; // Re-throw to prevent partially initialized core
    }
  }

  /* eslint-disable max-lines-per-function */
  private registerMessageHandlers(ideSettingsPromise: Promise<IdeSettings>) {
    const on = this.messenger.on.bind(this.messenger);

    // Note, VsCode's in-process messenger doesn't do anything with this
    // It will only show for jetbrains
    this.messenger.onError((message, err) => {
      // just to prevent duplicate error messages in jetbrains (same logic in webview protocol)
      if (
        ["llm/streamChat", "chatDescriber/describe"].includes(
          message.messageType,
        )
      ) {
        return;
      } else {
        void this.ide.showToast("error", err.message);
      }
    });

    on("abort", (msg) => {
      this.abortById(msg.data ?? msg.messageId);
    });

    on("ping", (msg) => {
      if (msg.data !== "ping") {
        throw new Error("ping message incorrect");
      }
      return "pong";
    });

    // History
    on("history/list", async (msg) => {
      const sessions = await historyManager.list(msg.data);
      const limit = msg.data?.limit ?? 100;
      return sessions.slice(0, limit);
    });

    on("history/delete", async (msg) => {
      await this.hookLifecycleReady;
      await this.endHookSession(msg.data.id, "clear");
      await historyManager.delete(msg.data.id);
    });

    on("history/load", async (msg) => {
      await this.hookLifecycleReady;
      const session = await historyManager.load(msg.data.id);
      await this.startHookSession(session.sessionId, "resume");
      return session;
    });

    on("history/save", async (msg) => historyManager.save(msg.data));
    on(
      "history/rename",
      async (msg) =>
        await historyManager.renameExisting(msg.data.id, msg.data.title),
    );

    on("history/share", async (msg) => {
      const session = await historyManager.load(msg.data.id);
      const outputDir = msg.data.outputDir;
      const history = session.history.map((msg) => msg.message);
      await shareSession(this.ide, history, outputDir);
    });

    on("history/clear", async () => {
      await this.hookLifecycleReady;
      for (const sessionId of this.activeHookSessions.keys()) {
        await this.endHookSession(sessionId, "clear");
      }
      await historyManager.clearAll();
    });

    on("devdata/log", async (msg) => {
      void DataLogger.getInstance().logDevData(msg.data);
    });

    on("config/addModel", async (msg) => {
      const model = msg.data.model;
      const { config } = await this.configHandler.loadConfig();
      const allModels = Object.values(config?.modelsByRole ?? {}).flat();
      const existing = allModels.find(
        (m) => m.providerName === model.provider && m.model === model.model,
      );
      if (existing) {
        void this.ide.showToast(
          "warning",
          "Model already exists in config. Update the API key in the config file.",
        );
        await this.configHandler.openConfigProfile();
        return;
      }
      addModel(model, msg.data.role);
      void this.configHandler.reloadConfig(
        "Model added (config/addModel message)",
      );
    });

    on("config/deleteModel", (msg) => {
      deleteModel(msg.data.title);
      void this.configHandler.reloadConfig(
        "Model removed (config/deleteModel message)",
      );
    });

    on("config/newPromptFile", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      await createNewPromptFileV2(this.ide, config?.experimental?.promptPath);
      await this.configHandler.reloadConfig(
        "Prompt file created (config/newPromptFile message)",
      );
    });

    on("config/newAssistantFile", async (msg) => {
      await createNewAssistantFile(this.ide, undefined);
      await this.configHandler.refreshAll(
        "Assistant file created (config/newAssistantFile message)",
      );
    });

    on("config/addLocalWorkspaceBlock", async (msg) => {
      await createNewWorkspaceBlockFile(
        this.ide,
        msg.data.blockType,
        msg.data.baseFilename,
      );
      walkDirCache.invalidate();
      await this.configHandler.reloadConfig(
        "Local block created (config/addLocalWorkspaceBlock message)",
      );
    });

    on("config/addGlobalRule", async (msg) => {
      try {
        await createNewGlobalRuleFile(this.ide, msg.data?.baseFilename);
        walkDirCache.invalidate();
        await this.configHandler.reloadConfig(
          "Global rule created (config/addGlobalRule message)",
        );
      } catch (error) {
        throw error;
      }
    });

    on("config/deleteRule", async (msg) => {
      try {
        const filepath = msg.data.filepath;
        if (
          !isColocatedRulesFile(filepath) &&
          !isContinueConfigRelatedUri(filepath)
        ) {
          throw new Error("Only rule files can be deleted");
        }
        const fileExists = await this.ide.fileExists(filepath);
        if (fileExists) {
          await this.ide.removeFile(filepath);
          walkDirCache.invalidate();
          await this.configHandler.reloadConfig(
            "Rule file deleted (config/deleteRule message)",
          );
        }
      } catch (error) {
        console.error("Failed to delete rule file:", error);
        throw error;
      }
    });

    on("config/openProfile", async (msg) => {
      await this.configHandler.openConfigProfile(msg.data.profileId);
    });

    on("config/ideSettingsUpdate", async (msg) => {
      await this.configHandler.updateIdeSettings(msg.data);
    });

    on("config/refreshProfiles", async (msg) => {
      // User force reloading will retrigger colocated rules
      const codebaseRulesCache = CodebaseRulesCache.getInstance();
      await codebaseRulesCache.refresh(this.ide);

      const { selectProfileId, reason } = msg.data ?? {};
      await this.configHandler.refreshAll(reason);
      if (selectProfileId) {
        await this.configHandler.setSelectedProfileId(selectProfileId);
      }
    });

    on("config/updateSharedConfig", async (msg) => {
      const newSharedConfig = this.globalContext.updateSharedConfig(msg.data);
      await this.configHandler.reloadConfig(
        "Shared config update (config/updateSharedConfig message)",
      );
      return newSharedConfig;
    });

    on("config/updateSelectedModel", async (msg) => {
      const newSelectedModels = this.globalContext.updateSelectedModel(
        msg.data.profileId,
        msg.data.role,
        msg.data.title,
      );
      await this.configHandler.reloadConfig(
        "Selected model update (config/updateSelectedModel message)",
      );
      return newSelectedModels;
    });

    on("mcp/reloadServer", async (msg) => {
      await MCPManagerSingleton.getInstance().refreshConnection(msg.data.id);
    });
    on("mcp/setServerEnabled", async (msg) => {
      const { id, enabled } = msg.data;
      await MCPManagerSingleton.getInstance().setEnabled(id, enabled);
    });
    on("mcp/getPrompt", async (msg) => {
      const { serverName, promptName, args } = msg.data;
      const prompt = await MCPManagerSingleton.getInstance().getPrompt(
        serverName,
        promptName,
        args,
      );
      const stringifiedPrompt = stringifyMcpPrompt(prompt);
      return {
        prompt: stringifiedPrompt,
        description: prompt.description,
      };
    });
    on("mcp/startAuthentication", async (msg) => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      MCPManagerSingleton.getInstance().setStatus(
        msg.data.serverId,
        "authenticating",
      );
      const status = await performAuth(
        msg.data.serverId,
        msg.data.serverUrl,
        this.ide,
      );
      if (status === "AUTHORIZED") {
        await MCPManagerSingleton.getInstance().refreshConnection(
          msg.data.serverId,
        );
      }
    });
    on("mcp/removeAuthentication", async (msg) => {
      removeMCPAuth(msg.data.serverUrl, this.ide);
      await MCPManagerSingleton.getInstance().refreshConnection(
        msg.data.serverId,
      );
    });

    // Context providers
    on("context/addDocs", async (msg) => {
      void this.docsService.indexAndAdd(msg.data);
    });

    on("context/removeDocs", async (msg) => {
      await this.docsService.delete(msg.data.startUrl);
    });

    on("context/indexDocs", async (msg) => {
      await this.docsService.syncDocsWithPrompt(msg.data.reIndex);
    });

    on("context/loadSubmenuItems", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        return [];
      }

      try {
        const items = await config.contextProviders
          ?.find((provider) => provider.description.title === msg.data.title)
          ?.loadSubmenuItems({
            config,
            ide: this.ide,
            fetch: (url, init) =>
              fetchwithRequestOptions(url, init, config.requestOptions),
          });
        return items || [];
      } catch (e) {
        Logger.error(e);
        return [];
      }
    });

    on("context/getContextItems", this.getContextItems.bind(this));

    on("context/getSymbolsForFiles", async (msg) => {
      const { uris } = msg.data;
      return await getSymbolsForManyFiles(uris, this.ide);
    });

    on("config/getSerializedProfileInfo", async (msg) => {
      return {
        result: await this.configHandler.getSerializedConfig(),
        profileId:
          this.configHandler.currentProfile?.profileDescription.id ?? null,
        profiles: this.configHandler.profileDescriptions,
      };
    });

    on("llm/streamChat", (msg) => {
      const abortController = this.addMessageAbortController(msg.messageId);
      return this.streamChatWithHooks(msg, abortController);
    });

    on("llm/complete", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      const model = config?.selectedModelByRole.chat;
      if (!model) {
        throw new Error("No chat model selected");
      }
      const abortController = this.addMessageAbortController(msg.messageId);

      const completion = await model.complete(
        msg.data.prompt,
        abortController.signal,
        msg.data.completionOptions,
      );
      return completion;
    });
    on("llm/listModels", this.handleListModels.bind(this));

    on("llm/compileChat", async (msg) => {
      const { messages, options } = msg.data;
      const model = (await this.configHandler.loadConfig()).config
        ?.selectedModelByRole.chat;

      if (!model) {
        throw new Error("No chat model selected");
      }

      return model.compileChatMessages(messages, options);
    });

    // Provide messenger to utils so they can interact with GUI + state
    TTS.messenger = this.messenger;
    ChatDescriber.messenger = this.messenger;

    on("tts/kill", async () => {
      void TTS.kill();
    });

    on("chatDescriber/describe", async (msg) => {
      const currentModel = (await this.configHandler.loadConfig()).config
        ?.selectedModelByRole.chat;

      if (!currentModel) {
        throw new Error("No chat model selected");
      }

      return await ChatDescriber.describe(currentModel, {}, msg.data.text);
    });

    on("conversation/compact", async (msg) => {
      await this.hookLifecycleReady;
      const currentModel = (await this.configHandler.loadConfig()).config
        ?.selectedModelByRole.chat;

      if (!currentModel) {
        throw new Error("No chat model selected");
      }

      await this.startHookSession(msg.data.sessionId, "compact");

      const compact = await this.runLifecycleHook(
        "PreCompact",
        msg.data.sessionId,
        { trigger: "manual", custom_instructions: null },
      );
      if (compact.blocked) {
        throw new Error(compact.reason || "Compaction blocked by hook");
      }

      try {
        await compactConversation({
          sessionId: msg.data.sessionId,
          index: msg.data.index,
          historyManager,
          currentModel,
        });
        return undefined;
      } catch (error) {
        Logger.error(`Error compacting conversation: ${error}`);
        return undefined;
      }
    });

    // Autocomplete
    on("autocomplete/complete", async (msg) => {
      const outcome =
        await this.completionProvider.provideInlineCompletionItems(
          msg.data,
          undefined,
        );
      return outcome ? [outcome.completion] : [];
    });
    on("autocomplete/accept", async (msg) => {
      this.completionProvider.accept(msg.data.completionId);
    });
    on("autocomplete/cancel", async (msg) => {
      this.completionProvider.cancel();
    });

    // Next Edit
    on("nextEdit/predict", async (msg) => {
      const outcome = await this.nextEditProvider.provideInlineCompletionItems(
        msg.data.input,
        undefined,
        {
          withChain: msg.data.options?.withChain ?? false,
          usingFullFileDiff: msg.data.options?.usingFullFileDiff ?? true,
        },
      );
      return outcome;
      // ? [outcome.completion, outcome.originalEditableRange]
    });
    on("nextEdit/accept", async (msg) => {
      console.log("nextEdit/accept");
      this.nextEditProvider.accept(msg.data.completionId);
    });
    on("nextEdit/reject", async (msg) => {
      console.log("nextEdit/reject");
      this.nextEditProvider.reject(msg.data.completionId);
    });
    on("nextEdit/startChain", async (msg) => {
      console.log("nextEdit/startChain");
      NextEditProvider.getInstance().startChain();
      return;
    });

    on("nextEdit/deleteChain", async (msg) => {
      console.log("nextEdit/deleteChain");
      await NextEditProvider.getInstance().deleteChain();
      return;
    });

    on("nextEdit/isChainAlive", async (msg) => {
      console.log("nextEdit/isChainAlive");
      return NextEditProvider.getInstance().chainExists();
    });

    on("nextEdit/queue/getProcessedCount", async (msg) => {
      console.log("nextEdit/queue/getProcessedCount");
      const queue = PrefetchQueue.getInstance();
      console.log(queue.processedCount);
      return queue.processedCount;
    });

    on("nextEdit/queue/dequeueProcessed", async (msg) => {
      console.log("nextEdit/queue/dequeueProcessed");
      const queue = PrefetchQueue.getInstance();
      return queue.dequeueProcessed() || null;
    });

    // NOTE: This is not used unless prefetch is used.
    // At this point this is not used because I opted to rely on the model to return multiple diffs than to use prefetching.
    on("nextEdit/queue/processOne", async (msg) => {
      console.log("nextEdit/queue/processOne");
      const { ctx, recentlyVisitedRanges, recentlyEditedRanges } = msg.data;
      const queue = PrefetchQueue.getInstance();

      await queue.process({
        ...ctx,
        recentlyVisitedRanges,
        recentlyEditedRanges,
      });
      return;
    });

    on("nextEdit/queue/clear", async (msg) => {
      console.log("nextEdit/queue/clear");
      const queue = PrefetchQueue.getInstance();
      queue.clear();
      return;
    });

    on("nextEdit/queue/abort", async (msg) => {
      console.log("nextEdit/queue/abort");
      const queue = PrefetchQueue.getInstance();
      queue.abort();
      return;
    });

    on("streamDiffLines", async (msg) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        throw new Error("Failed to load config");
      }

      const { data } = msg;

      // Title can be an edit, chat, or apply model
      // Fall back to chat
      const llm =
        config.modelsByRole.edit.find((m) => m.title === data.modelTitle) ??
        config.modelsByRole.apply.find((m) => m.title === data.modelTitle) ??
        config.modelsByRole.chat.find((m) => m.title === data.modelTitle) ??
        config.selectedModelByRole.chat;

      if (!llm) {
        throw new Error("No model selected");
      }

      const abortManager = ApplyAbortManager.getInstance();
      const abortController = abortManager.get(
        data.fileUri ?? "current-file-stream",
      ); // not super important since currently cancelling apply will cancel all streams it's one file at a time

      return streamDiffLines(
        data,
        llm,
        abortController,
        undefined,
        data.includeRulesInSystemMessage ? config.rules : undefined,
      );
    });

    on("getDiffLines", (msg) => {
      return myersDiff(msg.data.oldContent, msg.data.newContent);
    });

    on("cancelApply", async (msg) => {
      const abortManager = ApplyAbortManager.getInstance();
      abortManager.clear(); // for now abort all streams
    });

    on("onboarding/complete", this.handleCompleteOnboarding.bind(this));

    on("addAutocompleteModel", this.handleAddAutocompleteModel.bind(this));

    on("stats/getTokensPerDay", async (msg) => {
      const rows = await DevDataSqliteDb.getTokensPerDay();
      return rows;
    });
    on("stats/getTokensPerModel", async (msg) => {
      const rows = await DevDataSqliteDb.getTokensPerModel();
      return rows;
    });

    on("index/forceReIndex", async ({ data }) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config || config.disableIndexing) {
        return; // TODO silent in case of commands?
      }
      walkDirCache.invalidate();
      if (data?.shouldClearIndexes) {
        await this.codeBaseIndexer.clearIndexes();
      }
      const dirs = data?.dirs ?? (await this.ide.getWorkspaceDirs());
      await this.codeBaseIndexer.refreshCodebaseIndex(dirs);
    });
    on("index/setPaused", (msg) => {
      this.globalContext.update("indexingPaused", msg.data);
      // Update using the new setter instead of token
      this.codeBaseIndexer.paused = msg.data;
    });
    on("index/indexingProgressBarInitialized", async (msg) => {
      // Triggered when progress bar is initialized.
      // If a non-default state has been stored, update the indexing display to that state
      const currentState = this.codeBaseIndexer.currentIndexingState;

      if (currentState.status !== "loading") {
        void this.messenger.request("indexProgress", currentState);
      }
    });

    // File changes - TODO - remove remaining logic for these from IDEs where possible
    on("files/changed", this.handleFilesChanged.bind(this));
    const refreshIfNotIgnored = async (uris: string[]) => {
      const toRefresh: string[] = [];
      for (const uri of uris) {
        const ignore = await shouldIgnore(uri, this.ide);
        if (!ignore) {
          toRefresh.push(uri);
        }
      }
      if (toRefresh.length > 0) {
        this.messenger.send("refreshSubmenuItems", {
          providers: ["file"],
        });
        const { config } = await this.configHandler.loadConfig();
        if (config && !config.disableIndexing) {
          await this.codeBaseIndexer.refreshCodebaseIndexFiles(toRefresh);
        }
      }
    };

    on("files/created", async ({ data }) => {
      if (!data?.uris?.length) {
        return;
      }

      walkDirCache.invalidate();
      void refreshIfNotIgnored(data.uris);

      const colocatedRulesUris = data.uris.filter(isColocatedRulesFile);
      const nonColocatedRuleUris = data.uris.filter(
        (uri) => !isColocatedRulesFile(uri),
      );
      if (colocatedRulesUris) {
        const rulesCache = CodebaseRulesCache.getInstance();
        void Promise.all(
          colocatedRulesUris.map((uri) => rulesCache.update(this.ide, uri)),
        ).then(() => {
          void this.configHandler.reloadConfig("Codebase rule file created");
        });
      }

      // If it's a local config being created, we want to reload all configs so it shows up in the list
      if (nonColocatedRuleUris.some(isContinueAgentConfigFile)) {
        await this.configHandler.refreshAll("Local config file created");
      } else if (nonColocatedRuleUris.some(isContinueConfigRelatedUri)) {
        await this.configHandler.reloadConfig(
          ".continue config-related file created",
        );
      }
    });

    on("files/deleted", async ({ data }) => {
      if (!data?.uris?.length) {
        return;
      }

      walkDirCache.invalidate();
      void refreshIfNotIgnored(data.uris);

      const colocatedRulesUris = data.uris.filter(isColocatedRulesFile);
      const nonColocatedRuleUris = data.uris.filter(
        (uri) => !isColocatedRulesFile(uri),
      );

      if (colocatedRulesUris) {
        const rulesCache = CodebaseRulesCache.getInstance();
        void Promise.all(
          colocatedRulesUris.map((uri) => rulesCache.remove(uri)),
        ).then(() => {
          void this.configHandler.reloadConfig("Codebase rule file deleted");
        });
      }

      // If it's a local config being deleted, we want to reload all configs so it disappears from the list
      if (nonColocatedRuleUris.some(isContinueAgentConfigFile)) {
        await this.configHandler.refreshAll("Local config file deleted");
      } else if (nonColocatedRuleUris.some(isContinueConfigRelatedUri)) {
        await this.configHandler.reloadConfig(
          ".continue config-related file deleted",
        );
      }
    });

    on("files/closed", async ({ data }) => {
      console.debug("deleteChain called from files/closed");
      await NextEditProvider.getInstance().deleteChain();

      try {
        const fileUris = await this.ide.getOpenFiles();
        if (fileUris) {
          const filepaths = fileUris.map((uri) => uri.toString());

          if (!prevFilepaths.filepaths.length) {
            prevFilepaths.filepaths = filepaths;
          }

          // If there is a removal, including if the number of tabs is the same (which can happen with temp tabs)
          if (filepaths.length <= prevFilepaths.filepaths.length) {
            // Remove files from cache that are no longer open (i.e. in the cache but not in the list of opened tabs)
            for (const [key, _] of openedFilesLruCache.entriesDescending()) {
              if (!filepaths.includes(key)) {
                openedFilesLruCache.delete(key);
              }
            }
          }
          prevFilepaths.filepaths = filepaths;
        }
      } catch (e) {
        Logger.error(
          `didChangeVisibleTextEditors: failed to update openedFilesLruCache`,
        );
      }

      if (data.uris) {
        this.messenger.send("didCloseFiles", {
          uris: data.uris,
        });
      }
    });

    on("files/opened", async ({ data: { uris } }) => {
      if (uris) {
        for (const filepath of uris) {
          try {
            const ignore = await shouldIgnore(filepath, this.ide);
            if (!ignore) {
              // Set the active file as most recently used (need to force recency update by deleting and re-adding)
              if (openedFilesLruCache.has(filepath)) {
                openedFilesLruCache.delete(filepath);
              }
              openedFilesLruCache.set(filepath, filepath);
            }
          } catch (e) {
            Logger.error(
              `files/opened: failed to update openedFiles cache for ${filepath}`,
            );
          }
        }
      }
    });

    on("files/smallEdit", async ({ data }) => {
      const EDIT_AGGREGATION_OPTIONS = {
        deltaT: 1.0,
        deltaL: 5,
        maxEdits: 500,
        maxDuration: 120.0,
        contextSize: 5,
      };

      EditAggregator.getInstance(
        EDIT_AGGREGATION_OPTIONS,
        (
          beforeAfterdiff: BeforeAfterDiff,
          cursorPosBeforeEdit: Position,
          cursorPosAfterPrevEdit: Position,
        ) => {
          void processSmallEdit(
            beforeAfterdiff,
            cursorPosBeforeEdit,
            cursorPosAfterPrevEdit,
            data.configHandler,
            data.getDefsFromLspFunction,
            this.ide,
          );
        },
      );

      const workspaceDir =
        data.actions.length > 0 ? data.actions[0].workspaceDir : undefined;

      // Store the latest context data
      const instance = EditAggregator.getInstance();
      (instance as any).latestContextData = {
        configHandler: data.configHandler,
        getDefsFromLspFunction: data.getDefsFromLspFunction,
        recentlyEditedRanges: data.recentlyEditedRanges,
        recentlyVisitedRanges: data.recentlyVisitedRanges,
        workspaceDir: workspaceDir,
      };

      // queueMicrotask prevents blocking the UI thread during typing
      queueMicrotask(() => {
        void EditAggregator.getInstance().processEdits(data.actions);
      });
    });

    // Docs, etc. indexing
    on("indexing/reindex", async (msg) => {
      if (msg.data.type === "docs") {
        void this.docsService.reindexDoc(msg.data.id);
      }
    });
    on("indexing/abort", async (msg) => {
      if (msg.data.type === "docs") {
        this.docsService.abort(msg.data.id);
      }
    });
    on("indexing/setPaused", async (msg) => {
      if (msg.data.type === "docs") {
      }
    });
    on("docs/initStatuses", async (msg) => {
      void this.docsService.initStatuses();
    });
    on("docs/getDetails", async (msg) => {
      return await this.docsService.getDetails(msg.data.startUrl);
    });
    on("docs/getIndexedPages", async (msg) => {
      const pages = await this.docsService.getIndexedPages(msg.data.startUrl);
      return Array.from(pages);
    });

    on("didChangeSelectedProfile", async (msg) => {
      if (msg.data.id) {
        await this.configHandler.setSelectedProfileId(msg.data.id);
      }
    });

    on("auth/getAuthUrl", async (_msg) => {
      return { url: "" };
    });

    on("tools/call", async ({ data: { toolCall, sessionId } }) =>
      this.handleToolCall(toolCall, sessionId),
    );

    on("tools/runHook", async ({ data }) => {
      await this.hookLifecycleReady;
      const cwd = await this.getHooksCwd(data.sessionId);
      const result = await runToolHooks(
        data.event,
        data.toolCall.function.name,
        data.toolInput,
        data.toolCall.id,
        cwd,
        data.extra,
        undefined,
        data.sessionId,
        getSessionFilePath(data.sessionId),
      );
      return {
        blocked: result.blocked,
        reason: result.reason,
        updatedInput: result.updatedInput,
      };
    });

    on(
      "tools/evaluatePolicy",
      async ({ data: { toolName, basePolicy, parsedArgs, processedArgs } }) => {
        const { config } = await this.configHandler.loadConfig();
        if (!config) {
          throw new Error("Config not loaded");
        }

        const tool = config.tools.find((t) => t.function.name === toolName);
        if (!tool) {
          return { policy: basePolicy };
        }

        // Extract display value for specific tools
        let displayValue: string | undefined;
        if (toolName === "runTerminalCommand" && parsedArgs.command) {
          displayValue = parsedArgs.command as string;
        }

        if (tool.evaluateToolCallPolicy) {
          const evaluatedPolicy = tool.evaluateToolCallPolicy(
            basePolicy,
            parsedArgs,
            processedArgs,
          );
          return { policy: evaluatedPolicy, displayValue };
        }
        return { policy: basePolicy, displayValue };
      },
    );

    on("tools/preprocessArgs", async ({ data: { toolName, args } }) => {
      const { config } = await this.configHandler.loadConfig();
      if (!config) {
        throw new Error("Config not loaded");
      }

      const tool = config?.tools.find((t) => t.function.name === toolName);
      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      try {
        const preprocessedArgs = await tool.preprocessArgs?.(args, {
          ide: this.ide,
        });
        return {
          preprocessedArgs,
        };
      } catch (e) {
        let errorReason =
          e instanceof ContinueError ? e.reason : ContinueErrorReason.Unknown;
        let errorMessage =
          e instanceof Error
            ? e.message
            : `Error preprocessing tool call args for ${toolName}\n${JSON.stringify(args)}`;
        return {
          preprocessedArgs: undefined,
          errorReason,
          errorMessage,
        };
      }
    });

    on("isItemTooBig", async ({ data: { item } }) => {
      return this.isItemTooBig(item);
    });

    // Process state handlers
    on("process/markAsBackgrounded", async ({ data: { toolCallId } }) => {
      markProcessAsBackgrounded(toolCallId);
    });

    on(
      "process/isBackgrounded",
      async ({ data: { toolCallId }, messageId }) => {
        const isBackgrounded = isProcessBackgrounded(toolCallId);
        return isBackgrounded; // Return true to indicate the message was handled successfully
      },
    );

    on("process/killTerminalProcess", async ({ data: { toolCallId } }) => {
      await killTerminalProcess(toolCallId);
    });

    on("models/fetch", async (msg) => {
      try {
        return await fetchModels(
          msg.data.provider,
          msg.data.apiKey,
          msg.data.apiBase,
        );
      } catch (error: any) {
        void this.ide.showToast("error", error.message);
        return [];
      }
    });
  }

  private async getHooksCwd(sessionId?: string): Promise<string> {
    const remembered = sessionId && this.activeHookSessions.get(sessionId);
    if (remembered) return remembered;
    const workspaceUri = (await this.ide.getWorkspaceDirs())[0];
    if (!workspaceUri) return process.cwd();
    return workspaceUri.startsWith("file:")
      ? fileURLToPath(workspaceUri)
      : workspaceUri;
  }

  /** Called only by the trusted VS Code UI after its local broker handshake. */
  async bindBrokerLifecycle(
    chatSessionId: string,
    bridgeSessionId: string,
    token: string,
  ): Promise<void> {
    bindBrokerLifecycleBinding(chatSessionId, bridgeSessionId, token);
    try {
      const cwd = await this.getHooksCwd(chatSessionId);
      await startBrokerLifecycleBinding(chatSessionId, cwd);
    } catch (error) {
      throw error;
    }
  }

  private async runLifecycleHook(
    event:
      | "UserPromptSubmit"
      | "SessionStart"
      | "SessionEnd"
      | "Stop"
      | "PreCompact",
    sessionId: string,
    fields: Record<string, unknown>,
  ) {
    const cwd = await this.getHooksCwd(sessionId);
    // Broker receipt is independent of local hook implementation.  Without
    // an explicitly provisioned bridge token this is intentionally a no-op,
    // so an arbitrary VS Code process cannot self-attest DeepSeek parity.
    try {
      await emitBrokerLifecycle(event, sessionId, cwd, fields);
    } catch (error) {
      // The extension's own lifecycle/hook session remains authoritative for
      // UI availability. A missing broker must surface as absent parity in its
      // receipt, never turn every DeepSeek conversation into an outage.
      console.warn("Cukii broker lifecycle bridge unavailable", error);
    }
    const matcherValue =
      typeof fields.source === "string"
        ? fields.source
        : typeof fields.reason === "string"
          ? fields.reason
          : typeof fields.trigger === "string"
            ? fields.trigger
            : "";
    return runLifecycleHooks(
      event,
      fields,
      cwd,
      sessionId,
      getSessionFilePath(sessionId),
      matcherValue,
    );
  }

  private async startHookSession(
    sessionId: string,
    source: "startup" | "resume" | "clear" | "compact",
  ): Promise<string | undefined> {
    if (this.activeHookSessions.has(sessionId)) return undefined;
    const cwd = await this.getHooksCwd();
    // Journal before the observable start: a host crash after this point is
    // reconciled deterministically on next activation.
    this.hookSessionLedger.open({
      sessionId,
      cwd,
      openedAt: new Date().toISOString(),
      state: "starting",
      startInvocationId: uuidv4(),
    });
    this.activeHookSessions.set(sessionId, cwd);
    const started = await this.runLifecycleHook("SessionStart", sessionId, {
      source,
      hook_invocation_id:
        this.hookSessionLedger.get(sessionId)?.startInvocationId,
    });
    if (started.blocked) {
      this.activeHookSessions.delete(sessionId);
      this.hookSessionLedger.close(sessionId);
      throw new Error(started.reason || "Session start blocked by hook");
    }
    this.hookSessionLedger.markStarted(sessionId);
    return started.additionalContext;
  }

  private async endHookSession(
    sessionId: string,
    reason: "clear" | "other",
    recovered = false,
  ): Promise<void> {
    if (!this.activeHookSessions.has(sessionId) && !recovered) return;
    const endInvocationId =
      this.hookSessionLedger.get(sessionId)?.endInvocationId ?? uuidv4();
    this.hookSessionLedger.markEnding(sessionId, endInvocationId);
    const ended = await this.runLifecycleHook("SessionEnd", sessionId, {
      reason,
      hook_invocation_id: endInvocationId,
      ...(recovered ? { recovery: true } : {}),
    });
    if (ended.blocked)
      throw new Error(ended.reason || "Session end blocked by hook");
    this.activeHookSessions.delete(sessionId);
    this.hookSessionLedger.close(sessionId);
  }

  private async reconcileHookSessions(): Promise<void> {
    for (const entry of this.hookSessionLedger.list()) {
      this.activeHookSessions.set(entry.sessionId, entry.cwd);
      try {
        if (entry.state === "starting") {
          // The previous host died before acknowledging SessionStart. Replay a
          // marked recovery start so SessionEnd is never emitted on its own.
          const started = await this.runLifecycleHook(
            "SessionStart",
            entry.sessionId,
            {
              source: "startup",
              recovery: true,
              hook_invocation_id: entry.startInvocationId,
            },
          );
          if (started.blocked) {
            throw new Error(started.reason || "Recovery SessionStart blocked");
          }
          this.hookSessionLedger.markStarted(entry.sessionId);
        }
        await this.endHookSession(entry.sessionId, "other", true);
      } catch (error) {
        // Do not turn a blocking recovery hook into an allow. The readiness
        // promise rejects and every lifecycle/tool entrypoint remains closed.
        throw new Error(
          `Hook session recovery blocked for ${entry.sessionId}: ${String(error)}`,
        );
      }
    }
  }

  private async *streamChatWithHooks(
    msg: Message<ToCoreProtocol["llm/streamChat"][0]>,
    abortController: AbortController,
  ): AsyncGenerator<ChatMessage, PromptLog> {
    await this.hookLifecycleReady;
    const sessionId = msg.data.sessionId;
    const messages = msg.data.messages;
    const lastUser = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt =
      lastUser && typeof lastUser.content === "string" ? lastUser.content : "";

    const startContext = await this.startHookSession(sessionId, "startup");

    const submitted = await this.runLifecycleHook(
      "UserPromptSubmit",
      sessionId,
      { prompt },
    );
    if (submitted.blocked)
      throw new Error(submitted.reason || "Prompt blocked by hook");

    const initialContext = [startContext, submitted.additionalContext]
      .filter(Boolean)
      .join("\n");
    let streamMessage = msg;
    if (initialContext) {
      streamMessage = {
        ...msg,
        data: {
          ...msg.data,
          messages: [
            ...messages,
            {
              role: "user",
              content: `<hook_context>\n${initialContext}\n</hook_context>`,
            },
          ],
        },
      };
    }

    for (let stopAttempts = 0; ; stopAttempts++) {
      const stream = llmStreamChat(
        this.configHandler,
        abortController,
        streamMessage,
        this.ide,
        this.messenger,
      );
      let lastAssistantMessage = "";
      const stagedChunks: ChatMessage[] = [];
      let next = await stream.next();
      while (!next.done) {
        const chunk = next.value;
        if (chunk.role === "assistant" && typeof chunk.content === "string") {
          lastAssistantMessage += chunk.content;
        }
        stagedChunks.push(chunk);
        next = await stream.next();
      }

      const stopped = await this.runLifecycleHook("Stop", sessionId, {
        stop_hook_active: stopAttempts > 0,
        last_assistant_message: lastAssistantMessage,
      });
      if (!stopped.blocked) {
        // Stop is a commit gate: no assistant content reaches Redux/history
        // until all blocking hooks have allowed completion.
        for (const chunk of stagedChunks) yield chunk;
        return next.value;
      }
      if (stopAttempts >= 2) {
        throw new Error(
          stopped.reason || "Stop hook blocked completion repeatedly",
        );
      }
      streamMessage = {
        ...streamMessage,
        data: {
          ...streamMessage.data,
          messages: [
            ...streamMessage.data.messages,
            { role: "assistant", content: lastAssistantMessage },
            {
              role: "user",
              content: `<stop_hook_feedback>\n${stopped.additionalContext || stopped.reason || "Resolve the hook requirement before stopping."}\n</stop_hook_feedback>`,
            },
          ],
        },
      };
    }
  }

  public async shutdown(): Promise<void> {
    await this.hookLifecycleReady;
    for (const sessionId of [...this.activeHookSessions.keys()]) {
      await this.endHookSession(sessionId, "other");
    }
  }

  private async handleToolCall(toolCall: ToolCall, sessionId: string) {
    await this.hookLifecycleReady;
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      throw new Error("Config not loaded");
    }

    const tool = config.tools.find(
      (t) => t.function.name === toolCall.function.name,
    );

    if (!tool) {
      throw new Error(`Tool ${toolCall.function.name} not found`);
    }

    if (!config.selectedModelByRole.chat) {
      throw new Error("No chat model selected");
    }

    // Define a callback for streaming output updates
    const onPartialOutput = (params: {
      toolCallId: string;
      contextItems: ContextItem[];
    }) => {
      this.messenger.send("toolCallPartialOutput", params);
    };

    const cwd = await this.getHooksCwd(sessionId);
    const transcriptPath = getSessionFilePath(sessionId);
    const toolInput = safeParseToolCallArgs(toolCall) as Record<
      string,
      unknown
    >;
    const preToolUse = await runToolHooks(
      "PreToolUse",
      toolCall.function.name,
      toolInput,
      toolCall.id,
      cwd,
      {},
      undefined,
      sessionId,
      transcriptPath,
    );
    if (preToolUse.blocked) {
      return {
        contextItems: [],
        errorMessage: preToolUse.reason || "Blocked by hook",
      };
    }

    if (preToolUse.updatedInput !== undefined) {
      try {
        const processedArgs = await tool.preprocessArgs?.(
          preToolUse.updatedInput as Record<string, unknown>,
          {
            ide: this.ide,
          },
        );
        const policy = tool.evaluateToolCallPolicy?.(
          "allowedWithoutPermission",
          preToolUse.updatedInput as Record<string, unknown>,
          processedArgs,
        );
        if (policy && policy !== "allowedWithoutPermission") {
          return {
            contextItems: [],
            errorMessage:
              "Hook-updated tool input requires a new permission decision and was blocked.",
          };
        }
      } catch (error) {
        return {
          contextItems: [],
          errorMessage: `Hook-updated tool input was blocked: ${String(error)}`,
        };
      }
    }

    const effectiveToolCall =
      preToolUse.updatedInput === undefined
        ? toolCall
        : {
            ...toolCall,
            function: {
              ...toolCall.function,
              arguments: JSON.stringify(preToolUse.updatedInput),
            },
          };
    const effectiveInput = preToolUse.updatedInput ?? toolInput;
    let result;
    try {
      result = await callTool(tool, effectiveToolCall, {
        config,
        ide: this.ide,
        llm: config.selectedModelByRole.chat,
        fetch: (url, init) =>
          fetchwithRequestOptions(url, init, config.requestOptions),
        tool,
        toolCallId: toolCall.id,
        onPartialOutput,
        codeBaseIndexer: this.codeBaseIndexer,
      });
    } catch (error) {
      await runToolHooks(
        "PostToolUseFailure",
        toolCall.function.name,
        effectiveInput,
        toolCall.id,
        cwd,
        { error: String(error) },
        undefined,
        sessionId,
        transcriptPath,
      );
      throw error;
    }

    if (result.errorMessage) {
      await runToolHooks(
        "PostToolUseFailure",
        toolCall.function.name,
        effectiveInput,
        toolCall.id,
        cwd,
        { error: result.errorMessage },
        undefined,
        sessionId,
        transcriptPath,
      );
    } else {
      await runToolHooks(
        "PostToolUse",
        toolCall.function.name,
        effectiveInput,
        toolCall.id,
        cwd,
        { tool_response: result.contextItems },
        undefined,
        sessionId,
        transcriptPath,
      );
    }

    return result;
  }

  private async isItemTooBig(item: ContextItemWithId) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return false;
    }

    const llm = config?.selectedModelByRole.chat;
    if (!llm) {
      throw new Error("No chat model selected");
    }

    const tokens = countTokens(item.content, llm.model);

    if (tokens > llm.contextLength - llm.completionOptions!.maxTokens!) {
      return true;
    }

    return false;
  }

  private handleAddAutocompleteModel(
    msg: Message<{
      model: ModelDescription;
    }>,
  ) {
    const model = msg.data.model;
    editConfigFile(
      (config) => {
        return {
          ...config,
          tabAutocompleteModel: model,
        };
      },
      (config) => ({
        ...config,
        models: [
          ...(config.models ?? []),
          {
            name: model.title,
            provider: model.provider,
            model: model.model,
            apiKey: model.apiKey,
            roles: ["autocomplete"],
            apiBase: model.apiBase,
          },
        ],
      }),
    );
    void this.configHandler.reloadConfig("Autocomplete model added");
  }

  private async handleFilesChanged({
    data,
  }: Message<{
    uris?: string[];
  }>): Promise<void> {
    if (data?.uris?.length) {
      const diffCache = GitDiffCache.getInstance(getDiffFn(this.ide));
      diffCache.invalidate();
      walkDirCache.invalidate(); // safe approach for now - TODO - only invalidate on relevant changes
      const currentProfileUri =
        this.configHandler.currentProfile?.profileDescription.uri ?? "";
      for (const uri of data.uris) {
        if (URI.equal(uri, currentProfileUri)) {
          // Trigger a toast notification to provide UI feedback that config has been updated
          const showToast =
            this.globalContext.get("showConfigUpdateToast") ?? true;
          if (showToast) {
            const selection = await this.ide.showToast(
              "info",
              "Config updated",
              "Don't show again",
            );
            if (selection === "Don't show again") {
              this.globalContext.update("showConfigUpdateToast", false);
            }
          }
          await this.configHandler.reloadConfig(
            "Current profile config file updated",
          );
          continue;
        }
        if (isColocatedRulesFile(uri)) {
          try {
            const codebaseRulesCache = CodebaseRulesCache.getInstance();
            void codebaseRulesCache.update(this.ide, uri).then(() => {
              void this.configHandler.reloadConfig("Codebase rule update");
            });
          } catch (e) {
            Logger.error(`Failed to update codebase rule: ${e}`);
          }
        } else if (isContinueConfigRelatedUri(uri)) {
          await this.configHandler.reloadConfig(
            "Local config-related file updated",
          );
        } else if (
          uri.endsWith(".continueignore") ||
          uri.endsWith(".gitignore")
        ) {
          // Reindex the workspaces
          this.invoke("index/forceReIndex", {
            shouldClearIndexes: true,
          });
        } else {
          const { config } = await this.configHandler.loadConfig();
          if (config && !config.disableIndexing) {
            // Reindex the file
            const ignore = await shouldIgnore(uri, this.ide);
            if (!ignore) {
              await this.codeBaseIndexer.refreshCodebaseIndexFiles([uri]);
            }
          }
        }
      }
    }
  }

  private async handleListModels(msg: Message<{ title: string }>) {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    const model =
      config.modelsByRole.chat.find(
        (model) => model.title === msg.data.title,
      ) ??
      config.modelsByRole.chat.find((model) =>
        model.title?.startsWith(msg.data.title),
      );

    try {
      if (model) {
        return await model.listModels();
      } else {
        if (msg.data.title === "Ollama") {
          const models = await new Ollama({ model: "" }).listModels();
          return models;
        } else if (msg.data.title === "Lemonade") {
          const models = await new Lemonade({ model: "" }).listModels();
          return models;
        } else {
          return undefined;
        }
      }
    } catch (e) {
      console.debug(`Error listing Ollama models: ${e}`);
      return undefined;
    }
  }

  private async handleCompleteOnboarding(
    msg: Message<CompleteOnboardingPayload>,
  ) {
    const { mode, provider, apiKey } = msg.data;

    let editConfigYamlCallback: (config: ConfigYaml) => ConfigYaml;

    switch (mode) {
      case OnboardingModes.LOCAL:
        editConfigYamlCallback = setupLocalConfig;
        break;

      case OnboardingModes.API_KEY:
        if (provider && apiKey) {
          editConfigYamlCallback = (config: ConfigYaml) =>
            setupProviderConfig(config, provider, apiKey);
        } else {
          editConfigYamlCallback = setupQuickstartConfig;
        }
        break;

      default:
        Logger.error(`Invalid mode: ${mode}`);
        editConfigYamlCallback = (config) => config;
    }

    editConfigFile((c) => c, editConfigYamlCallback);

    void this.configHandler.reloadConfig("Onboarding completed");
  }

  private getContextItems = async (
    msg: Message<{
      name: string;
      query: string;
      fullInput: string;
      selectedCode: RangeInFile[];
      isInAgentMode: boolean;
    }>,
  ) => {
    const { config } = await this.configHandler.loadConfig();
    if (!config) {
      return [];
    }

    const { name, query, fullInput, selectedCode } = msg.data;

    const llm = (await this.configHandler.loadConfig()).config
      ?.selectedModelByRole.chat;

    if (!llm) {
      throw new Error("No chat model selected");
    }

    const provider = config.contextProviders?.find(
      (provider) => provider.description.title === name,
    );
    if (!provider) {
      return [];
    }

    try {
      const items = await provider.getContextItems(query, {
        config,
        llm,
        embeddingsProvider: config.selectedModelByRole.embed,
        fullInput,
        ide: this.ide,
        selectedCode,
        reranker: config.selectedModelByRole.rerank,
        fetch: (url, init) =>
          // Important note: context providers fetch uses global request options not LLM request options
          // Because LLM calls are handled separately
          fetchwithRequestOptions(url, init, config.requestOptions),
        isInAgentMode: msg.data.isInAgentMode,
      });

      return items.map((item) => {
        const id: ContextItemId = {
          providerTitle: provider.description.title,
          itemId: uuidv4(),
        };

        return { ...item, id };
      });
    } catch (e) {
      let knownError = false;

      if (e instanceof Error) {
        // After removing transformers JS embeddings provider from jetbrains
        // Should no longer see this error
        // if (e.message.toLowerCase().includes("embeddings provider")) {
        //   knownError = true;
        //   const toastOption = "See Docs";
        //   void this.ide
        //     .showToast(
        //       "error",
        //       `Set up an embeddings model to use @${name}`,
        //       toastOption,
        //     )
        //     .then((userSelection) => {
        //       if (userSelection === toastOption) {
        //         void this.ide.openUrl(
        //           "https://docs.continue.dev/customize/model-roles/embeddings",
        //         );
        //       }
        //     });
        // }
      }
      if (!knownError) {
        void this.ide.showToast(
          "error",
          `Error getting context items from ${name}: ${e}`,
        );
      }
      return [];
    }
  };
}
