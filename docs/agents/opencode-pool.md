# OpenCode agent pool

New project sessions default to `orchestrator` (`openai/gpt-6-luna#low`). The
orchestrator owns the user conversation and delegates architecture to
`architect` (`openai/gpt-6.2-sol#high`, subagent), implementation to
`implementer` (`openai/gpt-6.1-terra#medium`), and independent review to
`reviewer` (`openai/gpt-6.2-sol#medium`). Reviewer has no edit or shell
permission.

Use `@grill-with-docs` for architect-led design in one child session. The
orchestrator relays question rounds to the user and returns answers to that
same child; for architect-requested fact-finding, it dispatches relevant
sibling agents as directed by grilling and returns their findings. Architect
defers all ADR, glossary, spec, and ticket writes until user confirmation,
even when a skill suggests inline writing. Implementation waits for a separate
user instruction. Architect is also required for architecture-sensitive
requests, including new capabilities, contracts, database schemas, and trading
behavior. Small fixes with ready criteria go directly to implementation and
review. The orchestrator owns implementation, review coordination, fixes,
re-review, and final acceptance; reuse an existing ticket unless the user
requests a new breakdown.

The configured pool uses primary models only. The Ollama Cloud models listed
in `.scratch/opencode-agent-pool/spec.md` are agreed candidates, not configured
fallbacks. OpenCode V2 does not document automatic quota failover.

Verify the effective registry with `opencode debug agents` and
`opencode debug config`; use `opencode models` for available model IDs.
`npx skills list` reports installed skills, not necessarily OpenCode's runtime
discovery; verify skill discovery through OpenCode itself when possible.
Existing sessions retain an already-selected agent and model when defaults
change. The root model reference is variant-free; the orchestrator's agent
model specifies `low`. A fresh TUI may use saved preferences, so these defaults
do not guarantee the selection in every existing or preference-bearing session.
