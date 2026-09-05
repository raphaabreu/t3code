# Automatic account switching

Enable **Auto-switch on limit** beside the model control to keep a thread running when its
account reaches a usage limit. The option belongs to that thread and is separate from the
model picker. Existing threads save it immediately, including while an agent is working;
**Saving…** means the change has not yet been confirmed. Other connected clients receive the
saved setting. New threads keep the choice with their draft until the first message is sent.

The selected model and account stay in use until a detected usage limit interrupts the turn.
T3 Code then asks the configured account selector for a compatible account and continues the
interrupted request. Changing the model or selecting a different compatible account preserves auto-switch.
The selected account is used for the next message and remains eligible for automatic failover.
Uncheck the control to
stop future automatic switches; this does not switch back to an earlier account.

Account switching supports Claude and Codex profiles with compatible session storage. Their
account selectors must be installed and the profiles synchronized into the environment.
If no suitable account is available, the thread reports the selection error. Enabling the
option does not guarantee that another account has quota. Other providers, including Wolf,
continue to use their own account behavior.

On mobile, expand the thread composer to find the same switch beside the model control.
