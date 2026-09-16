# EOLab engineering instructions

These instructions are mandatory for repository work. The task prompt defines
the requested outcome; these instructions govern investigation,
implementation, verification, and GitHub workflow.

## Operating modes

Every task must be performed in exactly one of these modes.

### Audit mode

Audit mode is read-only with respect to repository files and history unless the
task explicitly authorizes creation of a report document or GitHub issue.

In audit mode:

- Do not edit source, tests, documentation, configuration, dependencies, or
  generated files.
- Do not create a branch, commit, or pull request.
- Do not reformat files.
- Record the exact baseline branch and commit SHA.
- Inspect current open issues and pull requests before classifying a finding.
- Identify overlapping, prerequisite, or superseding work.
- Inspect implementations, imports, call sites, tests, documentation, public
  contracts, deployment configuration, and relevant history.
- Architecture documentation and tests are evidence, not substitutes for
  inspecting the current implementation.
- Existing architecture may be questioned. Describe a proposed architectural
  redirection as an option or issue, but do not implement it.
- Distinguish demonstrated debt from preferences, stylistic alternatives, and
  speculative redesigns.
- Report intentional duplication, validation, polling, or locality as
  "no change recommended" when the evidence supports it.

### Remediation mode

Remediation mode implements one approved, bounded issue.

In remediation mode:

- Treat the current architecture and the approved issue as acceptance criteria.
- Do not broaden the issue into a repository-wide cleanup.
- Do not perform adjacent findings merely because the same files are open.
- Do not change an existing architectural boundary unless the issue explicitly
  approves that architectural change.
- Make the smallest coherent change that resolves the identified root cause.

Do not mix audit and remediation in one task or pull request.

## Before editing

Before changing any file:

1. Inspect the actual implementations, imports, call sites, tests, public
   contracts, architecture documentation, and relevant open work.

2. Identify:
    - the component that owns the behavior;
    - higher-level components that use it;
    - its existing lower-level dependencies;
    - its peer components;
    - every dependency relationship the proposed change would add, remove, or
      redirect.

3. Write a short architecture-impact statement using:
    - **Used by** for higher-level consumers;
    - **Depends on** for lower-level providers;
    - **Coordinates with** for peers.

4. State:
    - the owner;
    - all architectural components expected to change;
    - added, removed, and redirected dependency edges;
    - whether a component would acquire knowledge of a sibling;
    - public-contract changes;
    - remaining coupling or compromise.

5. Do not edit until that statement has been written.

If there is no clear existing owner, the proposed change reverses a dependency,
or the requested behavior conflicts with an established boundary, stop
implementation and present an architectural option. Do not silently put the
behavior into the nearest controller, route, viewer, service, or utility module.

## Required dependency boundaries

- Client components may depend on API clients. Backend services must not know
  about browser components.

- The browser composition root may coordinate catalog selection, the map,
  analysis controls, style controls, rendering controllers, catalog-vector selections,
  and Processing. Sibling components must not import, call, authorize, pause,
  or inspect one another's implementation state.

- Do not create another top-level browser coordinator merely to reduce the size
  of the existing composition root.

- The catalog is the authority for persistent source identity. Browser and
  public API requests must use catalog collection, item, asset, or opaque
  lifecycle identifiers. Never accept or publish arbitrary filesystem paths.

- Catalog selection, pixel analysis, statistical analysis, Processing
  calculations, and raster rendering are separate capabilities. They may be
  coordinated by composition and may share neutral source-reading mechanisms,
  but one capability must not use another capability's implementation state as
  an authorization or availability condition.

- Raster analysis and raster rendering are sibling subsystems:
    - pixel picking and statistics must not depend on GeoServer, WMS
      publication, rendering eligibility, renderer state, map visibility, or
      detail previews;
    - raster rendering must not own pixel picking, statistics, histograms, polygon
      analysis, or Processing calculations;
    - styling may consume analysis results only through an explicit result
      contract or the browser composition layer.

- Normal WMS rendering may depend on GeoServer.

- Detail-only rendering may depend on the bounded Rasterio/GDAL reading core.

- Raster analysis and Processing may depend on appropriate neutral bounded
  reading contracts without depending on rendering implementation state.

- Shared raster modules may contain only neutral source, grid, window,
  bounded-read, cache, coalescing, cancellation, and related source-lifecycle
  mechanisms. They must not contain UI, rendering-selection, styling,
  histogram-presentation, feature-specific workflow, or GeoServer policy.

- Catalog-vector analysis selections must use immutable, path-free source and
  predicate descriptors. Read original sources through neutral bounded contracts;
  do not persist filtered vector copies or reusable geometry snapshots.
  Processing may prepare exact polygons and temporary raster masks for a single
  calculation, within its memory and disk limits. Processing owns their cleanup;
  they must not become catalog sources or be shared across jobs.
  Optional display outlines must not authorize or gate analysis.

- Infrastructure components must not import or call application-level
  services.

- Lower-level source readers, caches, storage adapters, execution mechanisms,
  and contracts must not know which feature, route, or UI invoked them.

- Catalog search and raster pixel/statistics APIs must continue to work when
  the map viewer is removed or GeoServer is unavailable.

## Dependency budget

For an ordinary remediation:

- New cross-subsystem dependency edges: zero unless explicitly approved in the
  issue and architecture-impact statement.
- New top-level services or coordinators: zero unless no existing component
  legitimately owns the behavior and an architectural option has been
  approved.
- New public contracts: zero unless required by external behavior approved in
  the issue.
- Shared-module additions: only neutral mechanisms needed by at least two
  callers with the same semantics.
- New dependencies or build tools: zero unless separately justified and
  approved.

## Technical-debt evidence requirements

A finding must identify concrete paths, symbols, call sites, contracts, and
observable consequences. Similar naming, file size, or code shape alone is not
evidence of technical debt.

For every proposed consolidation, compare:

- accepted inputs;
- returned values;
- errors and exceptions;
- authorization and ownership;
- lifecycle and cancellation;
- resource limits;
- concurrency behavior;
- caching and staleness;
- performance characteristics;
- public and test contracts.

Do not consolidate code unless those semantics genuinely match.

Do not create a generic shared abstraction merely because two implementations
look similar. Prefer domain-local helpers when sharing would introduce
cross-component knowledge, weaken ownership, or create a less precise contract.

Classify apparent duplicates before recommending removal:

- active duplicate implementation;
- compatibility alias;
- public re-export;
- migration or wire-schema version;
- domain-specific value type;
- test fixture or fake;
- generated definition;
- dead or unreachable definition;
- stale documentation only.

Prove that a definition is unused before removing it. Search static imports,
dynamic registration, string-based dispatch, configuration, templates,
serialization, tests, migration code, and public exports.

Large files are investigation targets, not automatic refactoring findings.
Recommend extraction only when the file contains demonstrably distinct
ownership or dependency responsibilities.

## Programming-by-contract and validation

Preserve programming by contract: validate once at the component that owns the
boundary, then rely on the established contract below it.

Validation is normally required at:

- HTTP, browser, CLI, upload, and other user-input boundaries;
- catalog and external metadata boundaries;
- filesystem and mounted-source resolution;
- source signatures and staleness checks;
- database reads, migrations, persisted jobs, and serialization;
- native libraries, subprocesses, GDAL, GeoServer, and other external systems;
- authorization, session ownership, and lifecycle transitions;
- cache identity and invalidation;
- cancellation and concurrency transitions;
- memory, work, time, output-size, and other resource limits.

A validation check is a candidate for removal only when all of the following
are demonstrated:

- every caller is trusted and internal;
- every caller reaches the code through the owning validated boundary;
- the invariant is represented by the established contract;
- the check has no authorization, lifecycle, staleness, cancellation, or
  resource-limit role;
- removing it does not make failure later, less local, or harder to diagnose;
- tests prove the intended contract.

Do not remove a check merely because it appears repeatedly.

Do not replace security, data-integrity, lifecycle, or resource-limit checks
with `assert`. Assertions are appropriate only for programmer invariants that
cannot be caused by external or persisted data.

When the same invariant is checked at several internal layers, identify the
true owning boundary and propose removal from lower layers only after tracing
all call paths.

## Polling, notifications, and asynchronous work

Do not assume server push is inherently simpler or better than polling.

Classify each repeated request as one of:

- status polling;
- health or diagnostics sampling;
- bounded retry with backoff;
- debounce;
- cache revalidation;
- cancellation cleanup;
- periodic reconciliation.

Before recommending SSE, WebSockets, database notifications, or another push
mechanism, document:

- measured latency and request volume;
- expected update frequency;
- the authoritative state snapshot;
- notification loss and reconnect behavior;
- race handling between snapshot and subscription;
- replay requirements;
- authorization and owner isolation;
- proxy and deployment compatibility;
- connection, memory, and backpressure limits;
- shutdown and cleanup;
- fallback behavior;
- operational complexity.

Push notifications should normally be hints to refresh authoritative state, not
a second state store.

Periodic health and operational diagnostics may correctly remain polling.
Performance changes require before-and-after measurements and must be separated
from unrelated cleanup.

## CSS and browser presentation

Audit CSS for:

- duplicate selectors and declarations;
- contradictory rules;
- unnecessary specificity;
- avoidable `!important`;
- repeated hard-coded values that should use an existing token;
- dead selectors;
- inconsistent state-class naming;
- styles owned by the wrong component;
- unintentional source-order dependencies;
- inaccessible focus, disabled, busy, hidden, or error states;
- responsive overflow or layout inconsistencies.

Preserve cascade order, specificity, visual behavior, responsive behavior, and
accessibility. Do not mass-reformat CSS while making a semantic change.

Do not introduce a CSS framework, CSS-in-JS system, naming convention rewrite,
or wholesale stylesheet split as part of an ordinary cleanup issue.

Use real-browser or equivalent presentation verification when a change can
affect layout, visibility, focus, or interaction.

## Implementation discipline

- Make the smallest coherent change in the owning component.
- Keep one independently reviewable root cause per issue and pull request.
- Do not add unrelated responsibilities to coordinator, composition, route,
  viewer, or service modules.
- Prefer an existing interface or protocol at a component boundary.
- Do not bypass authorization, source-signature, lifecycle, resource-limit,
  cache, error, ownership, or cancellation contracts.
- Do not weaken a safety policy to simplify code.
- Do not duplicate a lower-level implementation inside another subsystem.
- Avoid new cross-subsystem imports.
- Do not change a public contract unless the approved issue requires it.
- Do not rename or move unrelated symbols.
- Do not reformat unrelated code.
- Preserve unrelated user changes.
- Separate behavior-preserving cleanup from behavior or performance changes.
- Do not add a compatibility shim unless an actual supported caller requires
  it.
- Do not modify tests merely to accept a new coupling or changed architecture.

## Documentation requirements

Every new or materially modified named class, function, method, or public
contract must have complete type information and documentation.

For Python:

- use complete type annotations;
- use Google-style docstrings;
- document `Args`, `Returns`, and `Raises` where applicable;
- describe contract semantics, not an implementation transcript.

For JavaScript:

- use complete JSDoc with parameters, return values, and thrown errors where
  applicable.

Do not perform repository-wide docstring churn as part of an unrelated issue.
Untouched undocumented code is a separate finding.

## Verification

- Add tests at the component that owns the behavior.
- Add integration tests at real component boundaries rather than exposing
  internals.
- Preserve tests proving catalog search and raster analysis work without the
  map viewer.
- Preserve tests proving pixel and statistical analysis work without
  GeoServer or a published rendering layer.
- Preserve Processing, catalog-selection, source, authorization, cancellation,
  staleness, and resource-limit contracts relevant to the change.
- Add a dependency/import regression test when a demonstrated boundary is
  important and accidental reversal would be costly.
- Prefer precise existing architecture tests over a generic dependency
  framework.
- Run the smallest relevant tests during development and the required complete
  suites before reporting completion.
- Run the production frontend build for browser changes.
- Report skipped or unavailable tests explicitly.
- Never claim a command passed unless it was actually executed against the
  reported commit.

## GitHub workflow

- Create or identify the GitHub issue before implementation.
- Assign every issue and pull request to `richpsharp`.
- Use exactly one branch-kind prefix:
    - `task/<issue-number>-<kebab-case-summary>`
    - `feature/<issue-number>-<kebab-case-summary>`
    - `bugfix/<issue-number>-<kebab-case-summary>`
- Do not use `task/feature/bugfix/...` as a combined path.
- Base independent remediation branches on current `main`.
- Do not stack pull requests unless the dependency is explicit and unavoidable.
- Identify overlapping open pull requests before starting.
- Use one pull request per issue and root cause.
- Create every pull request as an actual GitHub draft.
- After creating or updating a pull request, verify its actual draft state and
  assignee through GitHub rather than relying on its description.
- Keep the pull request in draft until `richpsharp` has personally verified that
  the application can deploy and behave correctly.
- Successful CI or an automated deployment does not by itself authorize
  marking the pull request ready.
- Do not merge the pull request unless explicitly instructed.
- Use one commit per independently reviewable issue raised during review.
- A review comment requiring a separate code correction should normally receive
  a separate commit.
- Group comments into one commit only when they describe the same root cause or
  cannot be separated while keeping the code and tests coherent.
- Do not create one commit per superficial line comment when one root-cause
  change resolves them together.

## Required pull-request report

Every remediation pull request must report:

1. The component that owns the implementation.
2. Every architectural component changed.
3. The **Used by**, **Depends on**, and **Coordinates with** relationships.
4. Every dependency relationship added, removed, or redirected.
5. Whether any subsystem acquired knowledge of a sibling.
6. Every public-contract change.
7. Any architectural compromise or remaining coupling.
8. The behavior and safety invariants preserved.
9. The exact tests, builds, formatters, linters, and checks executed.
10. Tests that were skipped or could not be executed, with the reason.
11. The exact commit deployed for verification, when applicable.
12. Confirmation of the actual GitHub draft and assignee state.

If satisfying the functional request conflicts with these constraints, stop
implementation and explain the conflict rather than implementing a shortcut.
