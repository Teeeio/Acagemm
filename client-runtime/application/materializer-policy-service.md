# Materializer Policy Service Contract

Classifies baseline Materializer state as `continue`, `wait`, `recover`, or `materialize`. This service is pure and never consumes recovery budget. The recovery service exclusively owns bounded retry consumption, state mutation, persistence, and research side effects.
