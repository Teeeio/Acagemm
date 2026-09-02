# Materializer Policy Service Contract

Classifies baseline Materializer state as `continue`, `wait`, `redirect`, `needs_human`, or `materialize`. Failed states consume one bounded recovery budget. This service is pure policy orchestration; persistence and research side effects remain injected by callers.
