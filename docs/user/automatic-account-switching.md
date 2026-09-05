# Automatic account switching

Enable automatic account switching beside the model control to keep a thread running when
its account reaches a usage limit or Claude reports that the organization has disabled
subscription access. The setting is saved per thread and shared with connected clients.
New threads keep the choice with their draft until the first message is sent.

The selected model and account stay in use until a detected usage limit or disabled Claude subscription interrupts the turn.
T3 Code then asks the configured account selector for a compatible account and continues the
interrupted request. Changing the model or selecting a different compatible account preserves auto-switch.
The selected account is used for the next message and remains eligible for automatic failover.
Turn automatic switching off to
stop future automatic switches; this does not switch back to an earlier account.

Account switching supports Claude and Codex profiles with compatible session storage. Their
account selectors must be installed and the profiles synchronized into the environment.
If no suitable account is available, the thread reports the selection error. Enabling the
option does not guarantee that another account has quota. Other providers, including Wolf,
continue to use their own account behavior.

On mobile, expand the thread composer to find the same switch beside the model control.
