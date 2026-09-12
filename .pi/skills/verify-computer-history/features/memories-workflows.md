# Memories and workflows

Memories and workflows surface what background processing distilled: the Memories window shows suggested/confirmed/rejected memory rows (Confirm, Reject, Forget), and the Workflows window shows mined workflow candidates with steps and occurrences (Confirm, Reject).

## Sub-features

- `memories-list` groups rows into confirmed/suggestions/rejected views.
- `memory-confirm` promotes a suggestion to confirmed.
- `memory-reject` moves a suggestion to rejected.
- `memory-forget` permanently removes one memory and its evidence.
- `workflows-list` returns candidates with steps and occurrences.
- `workflow-decide` confirms or rejects a candidate.

## How to get to it (user POV)

- Open the Memories window; pick Suggested, Confirmed, or Rejected.
- On a suggestion choose Confirm or Reject; on any row Forget removes it permanently.
- Open the Workflows window; on a candidate choose Confirm or Reject.
- Verification drives the same ops with `ch-ipc request`.

## Driving it with ch-ipc

Preconditions:

- Daemon is healthy at a disposable `$CH_HOME` (`ch-ipc doctor` exits 0).
- Fresh home: no background LLM runs, so lists start empty (extraction needs credentials).
- Write paths need a real row id; on an empty home prove the list shape and the typed `not_found` miss.

- **List memories.** Read all groups. Run `node .pi/skills/verify-computer-history/helpers/ch-ipc.mjs request --home "$CH_HOME" --op memories.list --params '{}'`. `result.groups` covers `confirmed`, `suggestions`, `rejected` in order, each with a `memories` array (empty on a fresh home).
- **Memory miss.** Act on a random ULID. Run `ch-ipc request --home "$CH_HOME" --op memory.action --params '{"id":"01J0000000000000000000000","action":"confirm"}'`. The daemon answers `ok:false error.not_found` (exit 3) — proof the guard works.
- **List workflows.** Run `ch-ipc request --home "$CH_HOME" --op workflows.list --params '{}'`. `result.workflows` is an array (empty on a fresh home).
- **Workflow miss.** Run `ch-ipc request --home "$CH_HOME" --op workflow.action --params '{"id":"01J0000000000000000000000","action":"confirm"}'`. Same typed `error.not_found`.
- **Decide when seeded.** Only when a row exists (LLM-backed runs): confirm it, re-list the group, and show the row moved groups; `forget` a memory and re-list to show it gone from every group. Record the id used.
- **Proof.** Save the list outputs and both miss responses under `verification-evidence/<run-id>/memories-workflows/`. The artifacts show group shapes and the `not_found` guards; when rows existed, the before/after lists showing the move.

## Gotchas

- Without LLM credentials there are no suggested rows to click — do not fake one with SQL inserts; prove the list shape and the miss guards, and report decides as unreached with the unmet precondition.
- `memory.action` ids are daemon-minted ULIDs; arbitrary strings fail param validation (`invalid_params`), only well-formed unknown ULIDs reach `not_found` — use the latter for the miss proof.
- A manually confirmed memory survives range deletes and retention; only `Forget` removes it — never "clean up" a confirmed memory to reset state.
- Mutations broadcast `memories_changed` / `workflows_changed` before the response frame; `ch-ipc` skips them while waiting — raw readers must not mistake them for the answer.
