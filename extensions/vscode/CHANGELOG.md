# Changelog

## 2.0.166

- **Cukii Chat.** The extension is now called Cukii Chat, with a new logo: the cookie cut out of a chat bubble.
- **Usage limits without your logins.** Claude and Codex limits now come from the CLIs themselves. Reading your stored login for them is an opt-in setting (`cukii.usage.directVendorApi`).
- **No orphaned agents.** If VS Code is killed instead of closed, the agent processes it started now stop too, instead of running on and spending quota.
- **Stop stops everything.** Stop now also ends the commands an agent started (a running build, test or `sleep`), not only the agent itself.
- **Stopped means stopped.** After you press Stop, the agent no longer restarts the stopped work on your next message unless you ask for it again.
- A stopped turn is marked **Interrupted** again, and code blocks no longer offer an **Apply** button that could not work without a Continue model.
- **Your shortcuts stay yours.** Cukii Chat no longer binds ⌥A, ⌘I, ⌘⇧R or the ⌥⌘Y/⌥⌘N diff keys everywhere, and the autocomplete, Next Edit, Quick Actions and indexing commands inherited from Continue are gone from the command palette.
- **Quieter UI.** The editor tip now only points to the chat, and the status bar no longer shows a crossed-out item while autocomplete is off.
- **The whole history stays reachable.** Scrolling up after a long agent turn no longer stops at the start of that turn; earlier messages keep loading.
- **You can see the route.** When you pick Opus, Fable, Kimi or Grok through Cursor, the model pill and run errors say “· Cursor”.
- **Cleaner transcript.** A reaction shows only its emoji, and Cukii’s own inbox and reaction calls no longer appear as raw tool cards.
- **Narrow panels.** A pinned message folded to one line keeps its text visible next to the time and ticks.

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
