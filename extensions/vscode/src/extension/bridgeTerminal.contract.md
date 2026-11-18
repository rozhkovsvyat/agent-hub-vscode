# Bridge terminal merge contract

When integrating another streaming state machine with the bridge, its waiting
state is the union of its own wait signal and the bridge's explicit terminal
receipt (`result` / `turn.completed`). Do not infer completion from assistant
text.

Reset wait on ordinary stream activity, explicit inactive, abort, new session,
and the terminal receipt. The terminal receipt is transport-only: consume it to
settle activity and do not persist it in transcript history.
