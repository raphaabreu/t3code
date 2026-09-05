# Review usage

The Usage page combines Codex, Claude Code, Grok Build, and Wolf activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

Wolf usage includes saved sessions created outside T3 Code. It reads the connected environment's
Wolf session history, including assistant replies, titles, goals, unsuccessful goal inference,
compactions, and branch summaries. Existing sessions are included when they fall within the
selected date range; they do not need to be reopened or imported into a thread.

When Wolf records a cost, that amount takes precedence over model-price estimates. Missing
costs are estimated only when a model price is known. Unpriced models are not evidence of free
usage, and recorded token costs do not represent a subscription invoice.

Only saved history can be recovered. Wolf sessions run without saving history, including
T3 Code's auxiliary Wolf calls for commit messages, PR text, branch names, and thread titles,
are not included in disk-derived totals.
