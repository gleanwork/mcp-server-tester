# Release Process

A release has two halves. A maintainer runs
[release-it](https://github.com/release-it/release-it/) locally: it picks the
version, writes the changelog with
[lerna-changelog](https://github.com/lerna/lerna-changelog/), commits, tags,
pushes, and creates the GitHub Release. The tag push then runs
[`publish.yml`](.github/workflows/publish.yml), which publishes the package to
npm from CI with [trusted publishing](https://docs.npmjs.com/trusted-publishers):
npm trusts that workflow through GitHub's OIDC token, so no npm token exists
anywhere, and every tarball carries a provenance attestation that ties it to its
commit and workflow run.

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
   Release; nothing else needs a credential.

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

4. Watch the [Publish workflow](https://github.com/gleanwork/mcp-server-tester/actions/workflows/publish.yml)
   run for the tag. It waits for the release commit's CI run to pass, checks that
   the tag matches `package.json`, builds, and publishes. A prerelease such as
   `2.0.0-beta.15` publishes under the `beta` dist-tag; a release publishes as
   `latest`.

If the publish fails, fix the cause and re-run the workflow run from the Actions
tab; the tag is unchanged. If the package itself needs a change, make it on main
and cut the next version.

[generate-token]: https://github.com/settings/tokens/new?scopes=repo&description=GITHUB_AUTH+env+variable

## One-time setup: trusted publishing on npm

A maintainer of `@gleanwork/mcp-server-tester` on npmjs.com does this once:

1. Package page -> Settings -> Trusted Publisher -> GitHub Actions.
2. Organization or user: `gleanwork`. Repository: `mcp-server-tester`.
   Workflow filename: `publish.yml`. Environment name: leave empty.
3. Under Publishing access, choose "Require two-factor authentication and
   disallow tokens". With trusted publishing in place, this makes the workflow
   the only way to publish.

Trusted publishing needs npm 11.5.1 or later in the workflow; `mise.toml` pins
`npm = "latest"`, so the runner has it.
