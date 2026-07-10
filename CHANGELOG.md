














## v1.1.1 (2026-07-10)

#### :rocket: Enhancement
* [#227](https://github.com/gleanwork/mcp-server-tester/pull/227) feat: capture tool call outputs and reference them by id in transcript ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))
* [#219](https://github.com/gleanwork/mcp-server-tester/pull/219) feat(evals): surface variant-experiment results in the reporter ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#218](https://github.com/gleanwork/mcp-server-tester/pull/218) feat(reporter): promote tool recall to a headline metric ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :bug: Bug Fix
* [#226](https://github.com/gleanwork/mcp-server-tester/pull/226) fix(evals): surface the real provider error on mcp_host 404s ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#225](https://github.com/gleanwork/mcp-server-tester/pull/225) fix(evals): warn once when testInfo is missing ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#217](https://github.com/gleanwork/mcp-server-tester/pull/217) fix(reporter): align tab nav width with content ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal
* [#228](https://github.com/gleanwork/mcp-server-tester/pull/228) fix: unblock CI on main after #227 (format:check + lint) ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))

#### Committers: 2
- Chenhao Yang ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v1.1.0 (2026-06-18)

#### :rocket: Enhancement

- [#204](https://github.com/gleanwork/mcp-server-tester/pull/204) feat: add external eval result storage ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#213](https://github.com/gleanwork/mcp-server-tester/pull/213) feat: add runVariantExperiment for AI-driven tool variant optimization ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#201](https://github.com/gleanwork/mcp-server-tester/pull/201) feat: add eval run comparison utility ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#200](https://github.com/gleanwork/mcp-server-tester/pull/200) feat: add runtime tool overrides ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal

- [#203](https://github.com/gleanwork/mcp-server-tester/pull/203) internal: centralize public type exports ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 2

- Robert Jackson ([@rwjblue-glean](https://github.com/rwjblue-glean))
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))



## v1.0.1-beta.0 (2026-05-18)


## v1.0.0 (2026-04-21)

#### :rocket: Enhancement

- [#185](https://github.com/gleanwork/mcp-server-tester/pull/185) feat: add AI skills for test, eval, and host eval generation ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#177](https://github.com/gleanwork/mcp-server-tester/pull/177) fix: include response preview in matcher failure messages ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :bug: Bug Fix

- [#186](https://github.com/gleanwork/mcp-server-tester/pull/186) fix: terminate MCP session before closing client ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#182](https://github.com/gleanwork/mcp-server-tester/pull/182) fix: pre-release cleanup for documentation accuracy and validator diagnostics ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#181](https://github.com/gleanwork/mcp-server-tester/pull/181) fix: resolve pre-release gate P0/P1 blockers in examples and docs ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#179](https://github.com/gleanwork/mcp-server-tester/pull/179) fix: remove zod from install command in README ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#178](https://github.com/gleanwork/mcp-server-tester/pull/178) fix: remove stale glean-server references from example READMEs ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#174](https://github.com/gleanwork/mcp-server-tester/pull/174) fix: remove phantom systemPromptAdditions from docs ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#173](https://github.com/gleanwork/mcp-server-tester/pull/173) fix: export refreshAccessToken from public API ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#172](https://github.com/gleanwork/mcp-server-tester/pull/172) fix: case-insensitive AbortError check in eval runner ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :memo: Documentation

- [#183](https://github.com/gleanwork/mcp-server-tester/pull/183) docs: clarify runEvalDataset two-argument signature ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#176](https://github.com/gleanwork/mcp-server-tester/pull/176) docs: document programmatic validators and createMCPFixture ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#180](https://github.com/gleanwork/mcp-server-tester/pull/180) docs: add security warning about http:// for remote servers ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#179](https://github.com/gleanwork/mcp-server-tester/pull/179) fix: remove zod from install command in README ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#178](https://github.com/gleanwork/mcp-server-tester/pull/178) fix: remove stale glean-server references from example READMEs ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#175](https://github.com/gleanwork/mcp-server-tester/pull/175) docs: document runEvalCase() in API reference ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
- [#174](https://github.com/gleanwork/mcp-server-tester/pull/174) fix: remove phantom systemPromptAdditions from docs ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1

- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))



## v1.0.0-beta.8 (2026-04-07)

#### :rocket: Enhancement
* [#157](https://github.com/gleanwork/mcp-server-tester/pull/157) feat: support multiple judges per eval case ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))
* [#155](https://github.com/gleanwork/mcp-server-tester/pull/155) feat: add CLI host type for MCP host simulation ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))
* [#160](https://github.com/gleanwork/mcp-server-tester/pull/160) feat(auth): add customLoginFlow callback for complex OAuth flows ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#152](https://github.com/gleanwork/mcp-server-tester/pull/152) feat: add vertex-anthropic and anthropic-agent-sdk judge providers ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))
* [#153](https://github.com/gleanwork/mcp-server-tester/pull/153) feat: include judge metadata in eval results ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))
* [#149](https://github.com/gleanwork/mcp-server-tester/pull/149) feat: custom judge registry for user-defined judge executors ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))
* [#143](https://github.com/gleanwork/mcp-server-tester/pull/143) feat: regex pattern matching for tool call arguments ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))
* [#142](https://github.com/gleanwork/mcp-server-tester/pull/142) feat: include request data in eval results and HTML report ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))

#### :bug: Bug Fix
* [#159](https://github.com/gleanwork/mcp-server-tester/pull/159) chore(deps): override release-it's undici to fix 3 security alerts ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#144](https://github.com/gleanwork/mcp-server-tester/pull/144) fix: DetailModal crash when clicking on failed eval cases ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))

#### Committers: 2
- Chenhao Yang ([@chenhao-yang-glean](https://github.com/chenhao-yang-glean))
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v1.0.0-beta.7 (2026-03-18)


## v1.0.0-beta.6 (2026-03-10)

#### :rocket: Enhancement
* [#138](https://github.com/gleanwork/mcp-server-tester/pull/138) feat: omit tool responses from saved baseline files by default ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :bug: Bug Fix
* [#139](https://github.com/gleanwork/mcp-server-tester/pull/139) fix: per-iteration tool call trace and prompt overflow as infra error ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v1.0.0-beta.5 (2026-03-10)

#### :rocket: Enhancement
* [#137](https://github.com/gleanwork/mcp-server-tester/pull/137) feat: reporter UX improvements ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#136](https://github.com/gleanwork/mcp-server-tester/pull/136) feat: add 95% Wilson CI to multi-iteration eval results ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v1.0.0-beta.4 (2026-03-09)

#### :boom: Breaking Change
* [#123](https://github.com/gleanwork/mcp-server-tester/pull/123) refactor!: rename llm_host eval mode to mcp_host ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :rocket: Enhancement
* [#124](https://github.com/gleanwork/mcp-server-tester/pull/124) feat(reporter-ui): show CI badge in report header for CI-generated reports ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#125](https://github.com/gleanwork/mcp-server-tester/pull/125) feat(reporter-ui): respect prefers-reduced-motion OS preference ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#123](https://github.com/gleanwork/mcp-server-tester/pull/123) refactor!: rename llm_host eval mode to mcp_host ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#117](https://github.com/gleanwork/mcp-server-tester/pull/117) refactor(reporter-ui): extract shared rateColorClass and formatMs utilities ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#110](https://github.com/gleanwork/mcp-server-tester/pull/110) feat(reporter-ui): tabbed layout separating Tests and Evals views ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :bug: Bug Fix
* [#132](https://github.com/gleanwork/mcp-server-tester/pull/132) fix: update init template deps to match library versions ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#130](https://github.com/gleanwork/mcp-server-tester/pull/130) fix: resolve all v1.0.0 release verification blockers ([@scalvert](https://github.com/scalvert))
* [#129](https://github.com/gleanwork/mcp-server-tester/pull/129) fix: resolve all pre-1.0.0 release blockers ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#126](https://github.com/gleanwork/mcp-server-tester/pull/126) docs: fix stale content, add markdown-code for snippet sync ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#121](https://github.com/gleanwork/mcp-server-tester/pull/121) fix(reporter-ui): show performance table for single-tool MCP servers ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#122](https://github.com/gleanwork/mcp-server-tester/pull/122) fix(reporter-ui): aggregate conformance checks across projects conservatively ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#120](https://github.com/gleanwork/mcp-server-tester/pull/120) fix(types): correct stale toolPrecision JSDoc ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#118](https://github.com/gleanwork/mcp-server-tester/pull/118) fix(reporter-ui): remove redundant guard on ConformanceCheck.message ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#119](https://github.com/gleanwork/mcp-server-tester/pull/119) fix(reporter-ui): aria-live filter announcements and remove source fallback ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#111](https://github.com/gleanwork/mcp-server-tester/pull/111) fix(reporter-ui): accessible names and Lucide icons for DarkModeToggle and Logo ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#114](https://github.com/gleanwork/mcp-server-tester/pull/114) fix: remove duplicate recharts dependency and phantom accuracy field in preview script ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#113](https://github.com/gleanwork/mcp-server-tester/pull/113) perf(reporter-ui): memoize TrendChart data and stabilize Recharts prop references ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#112](https://github.com/gleanwork/mcp-server-tester/pull/112) fix(reporter-ui): ARIA tab pattern, error boundaries, and data fallback fix in App ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#115](https://github.com/gleanwork/mcp-server-tester/pull/115) fix(reporter-ui): keyboard navigation, ARIA roles, and search performance in ResultsTable ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#116](https://github.com/gleanwork/mcp-server-tester/pull/116) fix(reporter-ui): accessibility and structure fixes for DetailModal ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :memo: Documentation
* [#135](https://github.com/gleanwork/mcp-server-tester/pull/135) docs: extract 22 freehand code blocks into tracked snippets ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#134](https://github.com/gleanwork/mcp-server-tester/pull/134) docs: wire MCPFixtureApi and EvalExpectBlock to source via markdown-code ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#133](https://github.com/gleanwork/mcp-server-tester/pull/133) docs: wire EvalCase and EvalRunnerResult to source via markdown-code ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#128](https://github.com/gleanwork/mcp-server-tester/pull/128) docs: document clientCredentials, baseline regression, and server comparison ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#126](https://github.com/gleanwork/mcp-server-tester/pull/126) docs: fix stale content, add markdown-code for snippet sync ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#123](https://github.com/gleanwork/mcp-server-tester/pull/123) refactor!: rename llm_host eval mode to mcp_host ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 2
- Steve Calvert ([@scalvert](https://github.com/scalvert))
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v1.0.0-beta.3 (2026-03-02)

#### :rocket: Enhancement
* [#103](https://github.com/gleanwork/mcp-server-tester/pull/103) feat: set User-Agent header on all HTTP MCP requests ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :bug: Bug Fix
* [#102](https://github.com/gleanwork/mcp-server-tester/pull/102) fix: add mise.toml and align all Node version references to Node 22 LTS ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#99](https://github.com/gleanwork/mcp-server-tester/pull/99) fix: remove accuracy alias, document snapshot context, complete README matcher table ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :memo: Documentation
* [#100](https://github.com/gleanwork/mcp-server-tester/pull/100) docs: document mcpAuthTest export and when to use it vs test fixture ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v1.0.0-beta.2 (2026-03-02)

#### :bug: Bug Fix
* [#95](https://github.com/gleanwork/mcp-server-tester/pull/95) fix: guard toMatchToolSnapshot against invalid regex + confirm partialMatch key-order safety ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#96](https://github.com/gleanwork/mcp-server-tester/pull/96) fix: warn on low iterations in llm_host mode and poor baseline coverage ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :memo: Documentation
* [#97](https://github.com/gleanwork/mcp-server-tester/pull/97) docs: document missing matchers, add 1.0 migration guide, add troubleshooting guide ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal
* [#98](https://github.com/gleanwork/mcp-server-tester/pull/98) chore: update CLAUDE.md LLMProvider list (remove ollama, add vertex-anthropic) ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v1.0.0-beta.1 (2026-03-02)

#### :rocket: Enhancement
* [#93](https://github.com/gleanwork/mcp-server-tester/pull/93) feat: re-export test fixtures from top-level package path ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :bug: Bug Fix
* [#91](https://github.com/gleanwork/mcp-server-tester/pull/91) fix: remove 'claude' judge provider alias, canonicalize on 'anthropic' ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#92](https://github.com/gleanwork/mcp-server-tester/pull/92) fix: add env to StdioMCPConfig, type samplingHandler, replace console.error ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#87](https://github.com/gleanwork/mcp-server-tester/pull/87) fix: classify infrastructure errors by err.code and document concurrency safety ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#86](https://github.com/gleanwork/mcp-server-tester/pull/86) fix: compute tool call precision accurately in non-exclusive mode ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#85](https://github.com/gleanwork/mcp-server-tester/pull/85) fix: remove @ai-sdk/ollama — package does not exist on npm ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal
* [#88](https://github.com/gleanwork/mcp-server-tester/pull/88) test: add comprehensive test suite for setupOAuth ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#89](https://github.com/gleanwork/mcp-server-tester/pull/89) test: add unit tests for toMatchToolSnapshot sanitizer logic ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#90](https://github.com/gleanwork/mcp-server-tester/pull/90) test: add CLI init and generate command tests ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#94](https://github.com/gleanwork/mcp-server-tester/pull/94) chore: remove internal QA review documents from docs/ ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#84](https://github.com/gleanwork/mcp-server-tester/pull/84) test: add bintastic integration tests for CLI commands ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v1.0.0-beta.0 (2026-03-01)

#### :rocket: Enhancement
* [#67](https://github.com/gleanwork/mcp-server-tester/pull/67) fix: change autoOpen reporter default from true to false ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#74](https://github.com/gleanwork/mcp-server-tester/pull/74) feat: add failureAlignment metric to server comparison ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#75](https://github.com/gleanwork/mcp-server-tester/pull/75) feat: add scenario and conversation history to llm_host simulation results ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#76](https://github.com/gleanwork/mcp-server-tester/pull/76) feat: export SnapshotSanitizers constants for IDE discoverability ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#48](https://github.com/gleanwork/mcp-server-tester/pull/48) feat: implement OAuth 2.1 client credentials grant for CI/CD machine-to-machine auth ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#40](https://github.com/gleanwork/mcp-server-tester/pull/40) feat: add TLS configuration (custom CA, client certs, rejectUnauthorized) to HttpMCPConfig ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#39](https://github.com/gleanwork/mcp-server-tester/pull/39) feat: handle 429 rate limit responses with Retry-After-aware backoff ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#27](https://github.com/gleanwork/mcp-server-tester/pull/27) feat: add experiment tracking metadata to eval results ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#26](https://github.com/gleanwork/mcp-server-tester/pull/26) feat: report judge score variance and warn on high stddev ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#41](https://github.com/gleanwork/mcp-server-tester/pull/41) feat: add HTTP proxy support via config or HTTP_PROXY/HTTPS_PROXY env vars ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#43](https://github.com/gleanwork/mcp-server-tester/pull/43) feat: expand built-in judge rubrics to 5-point scale ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#45](https://github.com/gleanwork/mcp-server-tester/pull/45) feat: aggregate tool precision/recall/F1 at dataset level in EvalRunnerResult ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#51](https://github.com/gleanwork/mcp-server-tester/pull/51) feat: warn when serverUrl uses http:// for non-localhost targets ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#42](https://github.com/gleanwork/mcp-server-tester/pull/42) feat: add HTTP-level trace logging via DEBUG=mcp-server-tester:http ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#17](https://github.com/gleanwork/mcp-server-tester/pull/17) feat(evals): EvalV2 parity + API cleanup — judge reps, rubric types, inline config, A/B comparison ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :bug: Bug Fix
* [#82](https://github.com/gleanwork/mcp-server-tester/pull/82) fix: declare all LLM provider peer deps and pin claude-agent-sdk ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#81](https://github.com/gleanwork/mcp-server-tester/pull/81) fix: replace duplicate UI types with re-exports from canonical source ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#80](https://github.com/gleanwork/mcp-server-tester/pull/80) fix: remove unused proxy credentials and sanitize proxy debug log ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#79](https://github.com/gleanwork/mcp-server-tester/pull/79) fix: sync CLI and template version from package.json ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#70](https://github.com/gleanwork/mcp-server-tester/pull/70) fix: move zod to dependencies (runtime requirement) ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#72](https://github.com/gleanwork/mcp-server-tester/pull/72) fix: add Zod schema validation for judge responses and preflight cost warning ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#68](https://github.com/gleanwork/mcp-server-tester/pull/68) fix: add HTTPS validation for OAuth discovery endpoints and scope downgrade warning ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#73](https://github.com/gleanwork/mcp-server-tester/pull/73) fix: replace accuracy metric with assertionPassRate + infrastructureErrorRate ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#77](https://github.com/gleanwork/mcp-server-tester/pull/77) fix: add call-level timeouts and HTTP connection pooling ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#31](https://github.com/gleanwork/mcp-server-tester/pull/31) fix: send notifications/cancelled before closing MCP client on test cleanup ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#35](https://github.com/gleanwork/mcp-server-tester/pull/35) fix: remove @ai-sdk/* from peerDependencies to resolve major version conflict ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#30](https://github.com/gleanwork/mcp-server-tester/pull/30) fix: remove sampling capability declaration when no handler is registered ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#28](https://github.com/gleanwork/mcp-server-tester/pull/28) fix: require content array in isCallToolResult type guard per MCP spec ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#29](https://github.com/gleanwork/mcp-server-tester/pull/29) fix: use package.json version in MCP client info instead of hardcoded 0.1.0 ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#33](https://github.com/gleanwork/mcp-server-tester/pull/33) fix: update @modelcontextprotocol/sdk to latest to resolve CVE ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#20](https://github.com/gleanwork/mcp-server-tester/pull/20) fix: write OAuth token files with 0o600 permissions (owner-only) ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#18](https://github.com/gleanwork/mcp-server-tester/pull/18) fix: pass authProvider to SSEClientTransport in HTTP fallback path ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#19](https://github.com/gleanwork/mcp-server-tester/pull/19) fix: apply connectTimeoutMs to client.connect() calls ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#23](https://github.com/gleanwork/mcp-server-tester/pull/23) fix: distinguish infrastructure errors from assertion failures in multi-iteration accuracy ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#21](https://github.com/gleanwork/mcp-server-tester/pull/21) fix: clear PKCE code verifier after successful token exchange ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#22](https://github.com/gleanwork/mcp-server-tester/pull/22) fix: redact state and code_challenge from OAuth debug logs ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#32](https://github.com/gleanwork/mcp-server-tester/pull/32) fix: export MCPConfig as discriminated union type for compile-time transport validation ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#57](https://github.com/gleanwork/mcp-server-tester/pull/57) fix: replace non-exported extractTextFromResponse with extractText in examples and docs ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#59](https://github.com/gleanwork/mcp-server-tester/pull/59) docs: update quickstart.md to remove deprecated v0.10 API references ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#46](https://github.com/gleanwork/mcp-server-tester/pull/46) feat: add runtime warnings when eval config violates evals guide recommendations ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#49](https://github.com/gleanwork/mcp-server-tester/pull/49) fix: add XML structural boundaries in judge prompts to prevent prompt injection ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#50](https://github.com/gleanwork/mcp-server-tester/pull/50) docs: replace dangerous console.log token example in JSDoc with safe usage pattern ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :memo: Documentation
* [#83](https://github.com/gleanwork/mcp-server-tester/pull/83) docs: rewrite README for clarity ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#71](https://github.com/gleanwork/mcp-server-tester/pull/71) docs: add Windows storage limitation, Vercel adapter eslint explanations, Node version audit ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#60](https://github.com/gleanwork/mcp-server-tester/pull/60) docs: fix incorrect function names in api-reference.md to match actual exports ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#37](https://github.com/gleanwork/mcp-server-tester/pull/37) docs: update CONTRIBUTING.md to require Node 22+ (was Node 18+) ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#64](https://github.com/gleanwork/mcp-server-tester/pull/64) docs: add CODEOWNERS and architecture.md to reduce bus-factor risk ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#58](https://github.com/gleanwork/mcp-server-tester/pull/58) docs: correct false claim about automatic reconnection in transports.md ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal
* [#71](https://github.com/gleanwork/mcp-server-tester/pull/71) docs: add Windows storage limitation, Vercel adapter eslint explanations, Node version audit ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#69](https://github.com/gleanwork/mcp-server-tester/pull/69) chore: delete dead reportTemplate.ts (908 lines of unused HTML/CSS/JS) ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#66](https://github.com/gleanwork/mcp-server-tester/pull/66) chore: remove pnpm-lock.yaml and add to .gitignore ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#36](https://github.com/gleanwork/mcp-server-tester/pull/36) fix: set playwright retries to 0 to surface flaky tests ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#55](https://github.com/gleanwork/mcp-server-tester/pull/55) test: add unit tests for OpenAI and Google judge implementations ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#53](https://github.com/gleanwork/mcp-server-tester/pull/53) test: add unit tests for CLI init and generate commands ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#52](https://github.com/gleanwork/mcp-server-tester/pull/52) test: add comprehensive unit tests for toPassToolJudge matcher ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#54](https://github.com/gleanwork/mcp-server-tester/pull/54) test: add unit tests for mcpReporter buildRunData including all expectation counters ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#56](https://github.com/gleanwork/mcp-server-tester/pull/56) test: add integration tests for Vercel AI SDK MCP tool schema conversion ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#63](https://github.com/gleanwork/mcp-server-tester/pull/63) test: dogfood custom matchers (toContainToolText, toBeToolError) in e2e tests ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.12.0 (2025-12-16)

#### :boom: Breaking Change
* [#15](https://github.com/gleanwork/mcp-server-tester/pull/15) chore: rename package from @mcp-testing/server-tester to @gleanwork/mcp-server-tester ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal
* [#16](https://github.com/gleanwork/mcp-server-tester/pull/16) fix: examples and exports after org migration ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.11.0 (2025-12-15)

#### :boom: Breaking Change
* [#14](https://github.com/mcp-testing/server-tester/pull/14) feat: unified assertion architecture with Playwright matchers ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

See [Migration Guide (v0.11)](docs/migration-0.11.md) for upgrade instructions.

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.10.4 (2025-12-13)


## v0.10.3 (2025-12-13)

#### :rocket: Enhancement
* [#13](https://github.com/mcp-testing/server-tester/pull/13) feat: improve reporter UI with collapsible panels and better layout ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.10.2 (2025-12-11)

#### :bug: Bug Fix
* [#12](https://github.com/mcp-testing/server-tester/pull/12) feat: Use Playwright context as single source of truth for reporter metadata ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.10.1 (2025-12-10)

#### :bug: Bug Fix
* [#11](https://github.com/mcp-testing/server-tester/pull/11) feat: Improve OAuth token refresh and simplify test fixture auth ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.10.0 (2025-12-10)

#### :rocket: Enhancement
* [#10](https://github.com/mcp-testing/server-tester/pull/10) feat: Migrate CLI commands to Ink ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#9](https://github.com/mcp-testing/server-tester/pull/9) feat: Add authType metadata for test result filtering ([@steve-calvert-glean](https://github.com/steve-calvert-glean))
* [#8](https://github.com/mcp-testing/server-tester/pull/8) feat: Add error expectation support for testing error cases ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1
- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))


## v0.9.0 (2025-12-06)

#### :boom: Breaking Change

- [#6](https://github.com/mcp-testing/server-tester/pull/6) refactor!: Simplify token storage API to single clear path ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### :house: Internal

- [#7](https://github.com/mcp-testing/server-tester/pull/7) chore: Apply Prettier formatting across codebase ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1

- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

## v0.8.0 (2025-12-05)

#### :rocket: Enhancement

- [#5](https://github.com/mcp-testing/server-tester/pull/5) feat: Add snapshot testing, token export command, and OAuth improvements ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

#### Committers: 1

- Steve Calvert ([@steve-calvert-glean](https://github.com/steve-calvert-glean))

## v0.7.0 (2025-12-04)

#### :rocket: Enhancement

- [#4](https://github.com/mcp-testing/server-tester/pull/4) fix: Hardens file permissions for token storage ([@scalvert](https://github.com/scalvert))
- [#3](https://github.com/mcp-testing/server-tester/pull/3) feat: Adds login CLI command for OAuth flows ([@scalvert](https://github.com/scalvert))

#### Committers: 1

- Steve Calvert ([@scalvert](https://github.com/scalvert))

## v0.6.1 (2025-12-01)

## v0.6.0 (2025-11-29)

## v0.5.1 (2025-11-27)

## v0.5.0 (2025-11-27)

# Changelog
