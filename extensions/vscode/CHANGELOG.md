# Changelog

## 2.0.160

- **Cukii Chat.** The extension is now called Cukii Chat, with a new logo: the cookie cut out of a chat bubble.
- **Usage limits without your logins.** Claude and Codex limits now come from the CLIs themselves. Reading your stored login for them is an opt-in setting (`cukii.usage.directVendorApi`).
- **No orphaned agents.** If VS Code is killed instead of closed, the agent processes it started now stop too, instead of running on and spending quota.

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
