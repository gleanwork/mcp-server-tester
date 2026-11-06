# Release Process

A release has two halves. A maintainer runs
[release-it](https://github.com/release-it/release-it/) locally: it picks the
version, writes the changelog with
[lerna-changelog](https://github.com/lerna/lerna-changelog/), commits, tags,
pushes, and creates the GitHub Release. The tag push then runs
[`publish.yml`](.github/workflows/publish.yml), which publishes the package to
npm from CI with [trusted publishing](https://docs.npmjs.com/trusted-publishers):
npm trusts that workflow, in this repository's `npm` environment, through
GitHub's OIDC token. No npm token exists anywhere, and every tarball carries a
provenance attestation that ties it to its commit and workflow run.

## Preparation

Confirm that every pull request merged since the last release has a
`lerna-changelog` label and a title that makes sense to a user. Changelogs are
for humans, not machines; see
[keepachangelog.com](https://keepachangelog.com/en/1.0.0/).

Labels:

- breaking - a breaking change.
- enhancement - a new feature or enhancement.
- bug - a fix for a bug in a previous release.
- documentation - adds or updates documentation.
- internal - an internal change that still deserves a mention.

## Release

1. Install dependencies: `npm install`.

2. Export a [GitHub personal access token][generate-token] with the `repo`
   scope as `GITHUB_AUTH`. release-it uses it for the changelog and the GitHub
   Release. Your own git credentials push the release commit and tag to `main`;
   nothing needs an npm credential.

   ```bash
   export GITHUB_AUTH=abc123def456
   ```

3. Run release-it:

   ```sh
   npx release-it
   ```

   It prompts for the version, lets you edit the changelog, then commits, tags
   `v<version>`, pushes both, and creates the GitHub Release. It does not publish
   to npm (`npm.publish` is off in `package.json`); don't run `npm publish` by
   hand either.

4. Open the [Publish workflow](https://github.com/gleanwork/mcp-server-tester/actions/workflows/publish.yml)
   run for the tag. Its `build` job waits for the release commit's CI run to
   pass, checks that the tag matches `package.json`, and packs the tarball. Its
   `publish` job then waits for the `npm` environment's approval. The environment
   prevents self-review, so another maintainer approves it, and it publishes. A prerelease such as `2.0.0-beta.15` publishes
   under its identifier as the dist-tag (`beta`); a release passes no dist-tag,
   so npm sets `latest` and refuses to move it to an older version.

If the publish fails, fix the cause and re-run the workflow run from the Actions
tab; the tag is unchanged. If the package itself needs a change, make it on main
and cut the next version. A release from a maintenance branch fails the CI gate,
which looks for push CI on the release commit; cut those from `main`.

[generate-token]: https://github.com/settings/tokens/new?scopes=repo&description=GITHUB_AUTH+env+variable

## One-time setup

Trusted publishing ties npm's trust to this repository, the `publish.yml`
workflow and the `npm` environment. Anyone with write access can push a `v*`
tag, so the environment's required approval is what keeps a tag alone from
publishing. Set up both sides.

On GitHub (repository admin), Settings -> Environments -> New environment,
named `npm`:

1. Required reviewers: the package maintainers, at least two, since the one who
   pushed the tag cannot approve. Leave "Allow administrators to bypass" off
   and "Prevent self-review" on.
2. Deployment branches and tags: "Selected branches and tags", add the tag rule
   `v*`.

On npmjs.com (package maintainer), `@gleanwork/mcp-server-tester` -> Settings:

1. Trusted Publisher -> GitHub Actions. Organization or user: `gleanwork`.
   Repository: `mcp-server-tester`. Workflow filename: `publish.yml`.
   Environment name: `npm`.
2. Allowed actions: enable direct publishing with `npm publish`. New
   configurations default to `npm stage publish` only, and the workflow runs
   `npm publish`.
3. Publishing access: "Require two-factor authentication and disallow tokens".
   With trusted publishing in place, the workflow and a maintainer's own 2FA
   session are the only ways to publish.

Trusted publishing needs npm 11.5.1 or later; the `publish` job uses the npm
that ships with Node 24 and installs nothing else.
