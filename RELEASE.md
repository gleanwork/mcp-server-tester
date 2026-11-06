# Release Process

Releases are mostly automated using
[release-it](https://github.com/release-it/release-it/) and
[lerna-changelog](https://github.com/lerna/lerna-changelog/).

## Preparation

Since the majority of the actual release process is automated, the primary
remaining task prior to releasing is confirming that all pull requests that
have been merged since the last release have been labeled with the appropriate
`lerna-changelog` labels and the titles have been updated to ensure they
represent something that would make sense to our users. Some great information
on why this is important can be found at
[keepachangelog.com](https://keepachangelog.com/en/1.0.0/), but the overall
guiding principle here is that changelogs are for humans, not machines.

When reviewing merged PR's the labels to be used are:

- breaking - Used when the PR is considered a breaking change.
- enhancement - Used when the PR adds a new feature or enhancement.
- bug - Used when the PR fixes a bug included in a previous release.
- documentation - Used when the PR adds or updates documentation.
- internal - Used for internal changes that still require a mention in the
  changelog/release notes.

## Release

Releases run in the Release workflow (`.github/workflows/release.yml`). It
publishes to npm with [trusted publishing][trusted-publishing], so it needs no
npm token and no one-time password.

1. Check the labels and titles of the pull requests since the last release
   (see Preparation). The changelog is generated from them, and the workflow
   has no editor step to fix it afterwards.
2. Do a dry run, and read the changelog in the run's log:

   ```sh
   gh workflow run release.yml -f increment=prerelease -f pre_release=beta -f dry_run=true
   ```

3. Release:

   ```sh
   gh workflow run release.yml -f increment=prerelease -f pre_release=beta
   ```

   `increment` is `prerelease`, `patch`, `minor` or `major`; `pre_release` is
   the prerelease identifier, empty for a final release. From `2.0.0-beta.14`:
   `prerelease` + `beta` gives `2.0.0-beta.15`; `prerelease` + `rc` gives
   `2.0.0-rc.0`; `major` alone gives `2.0.0`. A prerelease publishes under its
   identifier as the npm dist-tag (`beta`, `rc`); a final release becomes
   `latest`.

4. Check the result: the run succeeded (`gh run watch`),
   `npm view @gleanwork/mcp-server-tester versions` lists the new version, and
   the GitHub release exists.

The workflow runs `npx release-it <increment> --ci`. That bumps the version and
publishes to npm (`prepublishOnly` builds and tests first). Then it commits
`Release <version>`, tags `v<version>`, pushes both to `main` as the
`gleanwork-ci` GitHub App, and creates the GitHub release.

A pull request that changes `release.yml` or `.release-it.js` gets a dry run.

[trusted-publishing]: https://docs.npmjs.com/trusted-publishers

### One-time setup

- On npmjs.com, the package's Settings have a GitHub Actions trusted publisher
  with owner `gleanwork`, repository `mcp-server-tester`, workflow
  `release.yml`, environment `npm`, and "npm publish" allowed (new trusted
  publishers allow only `npm stage publish` until that is enabled).
- Publishing access is "Require two-factor authentication and disallow
  tokens". Trusted publishing still works with that setting.
- The repository has an `npm` environment that deploys only from `main`.
- `main` requires pull requests, so the release commit is pushed as the org's
  `gleanwork-ci` GitHub App, which is a bypass actor on `main`'s protection.
  Its credentials are the `APP_ID` and `APP_PRIVATE_KEY` organization secrets,
  shared with this repository; the token is scoped to this repository when it
  is minted.

### If a release fails after publishing

release-it publishes to npm before it commits and tags. If a later step fails,
npm has the new version and GitHub doesn't. Don't rerun the workflow: it would
try to publish the same version again, and npm versions can't be republished.
Finish the GitHub side from an up-to-date checkout of `main` instead. This is
the command in fish; `CI=true` turns off the changelog editor and the npm
checks:

```sh
env CI=true GITHUB_AUTH=(gh auth token) npx release-it <version> --no-npm.publish
```

### From a laptop

`npx release-it` still works locally. It opens the changelog in `$EDITOR`
before it commits, and npm asks for your one-time password when it publishes.
It needs `GITHUB_AUTH` set to a GitHub token with the `repo` scope.
