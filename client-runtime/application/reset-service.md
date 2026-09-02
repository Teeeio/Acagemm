# Reset Service Contract

Owns the explicit Demo Reset use case exposed to local Runtime clients.

`reset()` first calls the injected runtime capability guard with `Demo Reset`, then invokes the injected reset port and returns `{ state }`. Runtime guard errors, including `RUNTIME_ACTION_UNAVAILABLE` (409), propagate unchanged. The reset port must not run when the guard rejects the operation.

The service does not parse URLs, format HTTP responses, implement persisted-state deletion, select an Agent provider, or weaken production workflow invariants. Runtime capability checks and the reset implementation are injected.

```bash
npm run test:reset-service
npm run test:module-boundary
npm run test:smoke
```
