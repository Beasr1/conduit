# 08 — AI authoring (direction)

Status: direction, not scheduled. It's written now because it shapes v1:
the seams at the end cost little today and a rewrite later (D17).
Researched 2026-10-19. ✓ means checked first-hand on the source.

## Goal

A business team writes a detailed spec. An agent turns it into a workflow,
and into the API that workflow serves (D19), following our conventions.
People review, test and publish; nobody hand-configures nodes.

## Where I'd push back

- **Specs are never complete.** The agent has to come back with questions,
  not guesses, which is the rule we already hold ourselves to. GitHub's Spec
  Kit allows at most 3 open-question markers in a spec and 5 questions in
  its clarify step, each with a recommended answer ✓. Copy that: few
  questions, each with a proposed default.
- **"No config engineers" moves the job; it doesn't remove it.** Someone
  still owns the upstream catalogue: which APIs exist, their credentials,
  environments and rate limits. The agent can't invent API access. That
  role becomes curating the catalogue and approving publishes.
- **Side effects are the real risk,** e.g. a workflow that POSTs to a CRM.
  Every product checked keeps the same gate: the AI drafts, a person
  publishes.
  - n8n only ever runs the published version in production.
  - Make's assistant can't run or activate scenarios, and "never has access
    to your connections or keys" ✓.
  - Retool doesn't publish generated workflows automatically.
- **An approval nobody reads isn't a gate.** The review screen shows the
  diff, any new hosts, every step with side effects, and the test results.
- **HTTP steps are the hard part.** A third-party review found n8n's
  builder couldn't configure custom HTTP nodes, and every Conduit step is
  one. Most of the effort goes into upstream configuration: auth,
  pagination, error mapping.

## How it would work

```
spec ─► clarify ─► plan ─────► draft + tests ─► validate / dry-run / repair ─► review ─► publish
        (≤5 Qs)    (a person approves)                                          (a person publishes)
```

1. **Input:** the spec, plus the upstream catalogue. Acceptance criteria
   are written as "WHEN … THE SYSTEM SHALL …", Kiro's EARS style ✓.
2. **Clarify:** at most five questions, each with a proposed answer.
3. **Plan:** the agent proposes the graph (the steps, and the upstream
   operation behind each) before writing any mapping. A person approves.
4. **Draft:** a draft version, plus one test per acceptance criterion.
5. **Loop:** validate, fix from the JSON Pointer errors, dry-run against
   example responses, run the tests. Rounds are capped. It stops when
   everything passes or the budget runs out.
6. **Handover:** the draft, the tests and every assumption made. A person
   reviews and publishes.

Small edits ("add a header to fetch_user") skip steps 2 and 3.

## Harness

| Phase | What | Why this order |
|---|---|---|
| A | MCP server on the API, built with the official Go SDK (v1.8.0 ✓), exposing curated tools | any MCP client (Claude Code, Claude Desktop) can author workflows, and we write no agent loop |
| B | In-app authoring: a Go agent loop on the Claude API with tool use (anthropic-sdk-go's Tool Runner), sharing A's tool functions | business users get it in the UI, with no MCP client needed |
| C | Evals: 20–50 specs with known-good behaviour, graded by running their tests in dry-run | every prompt or model change is measured before it ships |

- **Curated tools, not one per endpoint.** Anthropic's tool-writing guide
  warns against tools that "merely wrap existing software functionality or
  API endpoints" ✓. FastMCP finds "significantly better performance" with
  curated servers than with auto-converted OpenAPI ones ✓. Roughly ten:
  `search_catalog`, `get_upstream`, `get_schema`, `create_draft`,
  `patch_draft` (JSON Patch), `validate`, `dry_run`, `run_tests`,
  `get_run`, `request_publish`.
- **Errors go back as tool errors.** The MCP spec says tool execution
  errors carry feedback models "can use to self-correct" ✓. Ours carry
  JSON Pointers, so each fix is targeted.
- **No one-shot generation of the whole definition.** Claude's structured
  outputs don't support recursive schemas ✓, and constrained decoding
  guarantees syntax, not meaning. Use strict schemas for small tool
  arguments and let the server's validator decide.
- **Model:** Claude Opus 5.5 (`claude-opus-5-5`) by default, as a config
  value. Measure on the evals before trying anything cheaper.
- **Borrow n8n's eval checks.** Its builder evals run deterministic checks
  such as `all_nodes_connected`, `no_hardcoded_credentials`,
  `expressions_reference_existing_nodes` and `valid_required_parameters` ✓.
  That's a ready-made list of how generated workflows go wrong.

## Guardrails

- **Rule of Two (Meta):** an agent should combine at most two of: untrusted
  input, sensitive data, and the power to change state. The authoring agent
  always reads untrusted input (specs, pasted docs, OpenAPI descriptions,
  example responses). So it gets no secrets and no production data, and
  everything it writes is an inert draft.
- **Scoped tokens:** agent tokens can edit drafts, validate and dry-run.
  They can't publish, run live or touch credentials.
- **Data, never instructions:** everything the agent reads is untrusted
  (OWASP LLM01, prompt injection).
- **A model-free runtime:** the engine runs the published definition
  deterministically, so upstream responses never reach a model at run time.
  An LLM step inside workflows would reopen that door; decide it
  deliberately if it ever comes up.
- **Bounded sessions:** capped repair rounds, token budget and wall time.
- **Audit:** every agent action records the actor, on whose behalf, the
  client, the model and the diff.
- **Same engine limits:** the SSRF guard and the JSONata guardrails apply to
  generated workflows unchanged. Sandboxing expressions isn't optional:
  - n8n shipped remote code execution through expression injection
    (CVE-2025-68613: 9.9 from GitHub, 8.8 from NVD). CISA has listed it as
    exploited in the wild since 2026-03-11 ✓.
  - jsonata-js itself had three code-execution advisories, fixed in 2.2.0
    and 2.2.1 ✓.

## What 07 must deliver first

- **Dry-run:** a run mode that answers from stored example responses and
  calls nothing external.
- **Test cases as data:** an input plus assertions (JSONata booleans over
  the output and node results), runnable through the API.
- **Catalogue import:** upstreams imported from their OpenAPI documents,
  with examples.
- **Caller keys for served workflows:** serving itself arrives in v1 (03,
  D19). 07 adds a key per served workflow, with `input_schema` and
  `output_schema` as its contract.
- **Separate permissions:** edit drafts, publish, run live, manage
  credentials.

## Seams v1 keeps (D17)

| Seam | Cost in v1 | Unlocks |
|---|---|---|
| Every UI action is in `schema/openapi.yaml`; no UI-only logic | discipline | agents use the API as it is |
| A flat definition (nodes array, edges by ID, no recursion) with a published schema | already the design | machine generation and validation |
| Validation returns every error at once, as RFC 9457 problem details with an `errors` list (JSON Pointer `pointer`, stable `code`, `detail`). Semantic errors are included: cycles, unknown node references, JSONata parse errors | small | repair loops; editor highlights |
| Stable, meaningful node IDs (`fetch_user`, not `node_7`) | none | agents and diffs can name steps |
| Versions go `draft` → `published`, and published versions are immutable | one column | agents draft, people publish |
| Drafts carry a `revision`, and writes send `If-Match` | small | an agent and a person can't overwrite each other |
| Provenance per version: actor, on whose behalf, client, model, source spec | a few columns | audit; evals per model |
| `input_schema` and `output_schema` per workflow | small | run validation, served APIs (03), workflows as agent tools |
| Optional layout (`ui`); the editor places nodes that have no position | small | generated definitions render |
| Auth puts a principal in the request context (only one in v1) | none | scoped agent tokens |
| Credentials only by ID; the API never returns secret values | already D14 | the model never sees secrets |
| Per-node traces readable through the API | already in 03 | agents debug their own drafts |

## Open questions (decide when 08 starts)

- Where specs live: inside Conduit, or linked from a docs tool.
- Whether the plan checkpoint is always required, or only for new
  workflows.
- What eval pass rate is good enough to ship phase B.

## Sources

Spec-driven development
- GitHub Spec Kit (templates/commands/specify.md, clarify.md) ✓: https://github.com/github/spec-kit
- Kiro specs, EARS ✓: https://kiro.dev/docs/specs/feature-specs/
- A critique of spec-driven tools: https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html

Prior art
- n8n AI Workflow Builder (credentials not sent ✓): https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder
- n8n save and publish: https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows/
- n8n builder eval checks ✓: https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/ai-workflow-builder.ee/evaluations/README.md
- Third-party n8n builder review: https://growwstacks.com/blog/n8n-ai-workflow-builder-review/
- Make Maia system card ✓: https://help.make.com/maia-by-make-system-card
- Kestra Copilot: https://kestra.io/docs/ai-tools/ai-copilot
- Retool generated workflows: https://docs.retool.com/4.0/workflows/guides/generate-with-ai
- Zapier Copilot: https://zapier.com/blog/zapier-copilot-guide

Harness
- MCP spec 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP tools, self-correcting errors ✓: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP security best practices: https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices
- MCP Go SDK, v1.8.0 ✓: https://github.com/modelcontextprotocol/go-sdk
- Anthropic Go SDK, v1.82.0 ✓: https://github.com/anthropics/anthropic-sdk-go
- "Writing effective tools for agents — with agents" ✓: https://www.anthropic.com/engineering/writing-tools-for-agents
- Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
- Evals for agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- FastMCP on OpenAPI conversion ✓: https://gofastmcp.com/integrations/openapi
- Claude structured outputs ✓: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

Security
- Meta, Agents Rule of Two: https://ai.meta.com/blog/practical-ai-agent-security/
- A counterpoint (Willison): https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/
- OWASP LLM01 prompt injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- OWASP Top 10 for agentic applications: https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/
- CVE-2025-68613 ✓: https://osv.dev/vulnerability/CVE-2025-68613 and https://nvd.nist.gov/vuln/detail/CVE-2025-68613
- CISA Known Exploited Vulnerabilities ✓: https://www.cisa.gov/known-exploited-vulnerabilities-catalog
- jsonata-js security advisories ✓: https://github.com/jsonata-js/jsonata/security/advisories

Standards
- RFC 9457, problem details, with the `errors[].pointer` example ✓: https://www.rfc-editor.org/rfc/rfc9457.html
- RFC 6902, JSON Patch: https://www.rfc-editor.org/rfc/rfc6902.html
- RFC 9110, `If-Match` (§13.1.1): https://www.rfc-editor.org/rfc/rfc9110.html
- React Flow auto-layout: https://reactflow.dev/learn/layouting/layouting
