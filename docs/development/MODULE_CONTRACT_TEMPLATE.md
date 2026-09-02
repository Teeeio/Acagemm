# Module Name

## Purpose

State why this module exists in one paragraph.

## Responsibilities

- List behavior owned by this module.

## Non-Responsibilities

- List behavior that must remain in another module.

## Public API

| Export or endpoint | Input | Output | Errors |
|---|---|---|---|
| `example()` | `ExampleInput` | `ExampleResult` | `EXAMPLE_INVALID` |

## Inputs

Define required fields, optional fields, units, defaults, and accepted states. Link to a schema or typedef where available.

## Outputs

Define return values, state changes, emitted events, written files, and spawned processes.

## Invariants

- List conditions that must remain true for every call.

## Dependencies

- Allowed imports:
- Forbidden imports:

## Side Effects

Describe filesystem, Git, process, network, state, and hardware effects. Write `None` for a pure module.

## Error Contract

List stable error codes, retryability, and caller behavior.

## Example

Provide one minimal supported call.

## Verification

List exact test commands.

## Change Checklist

- Update schemas or typedefs.
- Update contract and integration tests.
- Update this README when the contract changes.
- Check callers and persisted-state migrations.

## Known Limitations

List accepted limitations without describing planned behavior as already implemented.
