# Changelog

## 2.0.173

- **More accurate dictation, if you want it.** Set `cukii.voiceModel` to `small` for noticeably better recognition at about twice the time. It is a one-time 250 MB download, checksum-verified; dictation keeps using the built-in model until the download finishes.
- **A frozen Cukii page is reported.** If a Cukii panel stops responding, VS Code now says so after 45 seconds and offers **Reload Window**, with what to do if Cukii is still blank after it.
- **Install on Windows checks the result.** Installing an agent CLI now also installs its native component and reports success only once the CLI actually starts. A Codex install that is missing that component shows “Installed but cannot start” with **Install** to repair it, instead of a login that could not work.
- **No more empty messages from Claude.** When a background task an agent started finishes mid-turn, its notice no longer shows up as an empty message bubble with only a time; it goes into a collapsed “Thought” entry that names what finished.
- **Grok says sooner when it is stuck.** When Grok has finished starting but stays silent, Cukii reports it after the normal wait instead of ten minutes, and names any MCP server that failed to start.
- **Extra high for GPT-6.1.** The GPT-6.1 Sol models offer every effort level; High was wrongly shown as the maximum.
- **The pill reads “Cursor Opus 5.5”.** Models used through Cursor name Cursor first.
- **A pinned long message no longer overlaps its footer.** The text fades out before the time and status again.

## 2.0.172

- **New logo.** The Cukii Chat mark is now the cookie itself, with a reply tail — no bubble around it.
- **Voice input keeps your language.** With VS Code in English, Russian dictation used to come back translated into English. The spoken language is now detected from the start of each recording.
- **Long dictation is not lost.** Long recordings are recognized in full instead of failing with "repeated text", a recording that reaches the five-minute limit is transcribed instead of discarded, and if recognition fails the recording is kept so **Retry** can try again.
- **You can see what voice input is doing.** A red dot and a timer while recording, "Transcribing…" with a timer after you stop.
- **Pictures come back with arrow-up.** Recalling a previous message that had an image shows the image at once, not after the next keystroke.
- **No stray `tmp` folder.** Grok runs no longer leave a `tmp\sessions` folder at the root of your workspace drive.
- **Clearer messages.** A WebSocket hiccup Codex recovers from by itself no longer shows up as an error, and a Grok run that prints nothing says what Cukii can actually tell.
- Cukii no longer tells agents to use broker delegation tools that are not part of the extension.

## 2.0.171

- **Limits after a reset.** Once a usage window's reset time has passed, Account & usage shows it as fresh (0%) instead of the last value from the old window, such as 100% right after Opus resets.

## 2.0.170

- **No raw service lines.** When Kimi stops before answering (for example, out of quota), the chat no longer shows a raw `{"role":"meta",…}` line next to the error.
- **Fast only where it is real.** For models through Cursor, the Fast switch now appears exactly when Cursor offers a Fast version of that model (Opus, GPT-5.6, Grok 4.7 — yes; Sonnet — no).

## 2.0.169

- **Kimi limits are back.** The Kimi Account & Usage panel finds the login of Kimi CLI 2.x again and shows your 5-hour window.
- **The pill names the model that runs.** If your first message goes out before the model list loads, the model pill no longer shows “Opus 5” while the turn runs on Qwen.

## 2.0.168

- **Cukii Chat.** The extension is now called Cukii Chat, with a new logo: the cookie cut out of a chat bubble.
- **Usage limits without your logins.** Claude and Codex limits now come from the CLIs themselves. Reading your stored login for them is an opt-in setting (`cukii.usage.directVendorApi`).
- **No orphaned agents.** If VS Code is killed instead of closed, the agent processes it started now stop too, instead of running on and spending quota.
- **Stop stops everything.** Stop now also ends the commands an agent started (a running build, test or `sleep`), not only the agent itself.
- **Stopped means stopped.** After you press Stop, the agent no longer restarts the stopped work — on the next message or later — unless you ask for it again.
- A stopped turn is marked **Interrupted** again, and code blocks no longer offer an **Apply** button that could not work without a Continue model.
- **Your shortcuts stay yours.** Cukii Chat no longer binds ⌥A, ⌘I, ⌘⇧R or the ⌥⌘Y/⌥⌘N diff keys everywhere, and the autocomplete, Next Edit, Quick Actions and indexing commands inherited from Continue are gone from the command palette.
- **Quieter UI.** The editor tip now only points to the chat, and the status bar no longer shows a crossed-out item while autocomplete is off.
- **The whole history stays reachable.** Scrolling up after a long agent turn no longer stops at the start of that turn; earlier messages keep loading.
- **You can see the route.** When you pick Opus, Fable, Kimi or Grok through Cursor, the model pill and run errors say “· Cursor”.
- **Cleaner transcript.** A reaction shows only its emoji, and Cukii’s own inbox and reaction calls no longer appear as raw tool cards.
- **Narrow panels.** A pinned message folded to one line keeps its text visible next to the time and ticks.
- The pinned message of the last turn stays at the top as a single line until the end of the answer.
- Settings no longer list switches for features inherited from Continue that Cukii Chat does not use.
- In an untrusted folder VS Code now explains that Cukii Chat needs a trusted workspace, instead of showing empty tabs.

## 2.0.158

- Opus and Fable answer after resume instead of stopping with "No response requested."
- Background tasks started by Claude survive the turn; Claude continues when they finish.
- Opus 5.5 gets the effort, Fast and Thinking settings you pick; a refused Fast is shown in the chat.
- Qwen's ask-question waits for your answer as long as needed.
- Qwen sign-in asks for the API key right away; Codex signs in on the first try and shows one clear error when signed out.

## 2.0.154

- The pinned user message stays readable when it folds to one line.
- The ask-question sheet uses the plugin's dark theme.
- Codex sign-in works without VS Code shell integration.
- Qwen shows the quota reset time in the limits widget.

## 2.0.152

- Agent reactions sit inside the message bubble.
