# Release process

The browser library, server library and standalone collector are independently versioned MIT-licensed npm packages.

## Prepare a release

| Package | Directory | Release tag |
| --- | --- | --- |
| `@clearideas/consent-analytics` | repository root | `v<version>` |
| `@clearideas/consent-analytics-server` | `server/` | `server-v<version>` |
| `@clearideas/consent-analytics-collector` | `collector/` | `collector-v<version>` |

1. Use Node.js 24 and run the release checks for the package you are publishing. The browser checks use the sample host dependencies. The server and collector test matrix requires real service adapters, as configured in CI.
2. Update that package's `package.json` and `package-lock.json` to the intended version. Review the diff and commit the release source.
3. Build the package and inspect the contents with `npm pack --dry-run --ignore-scripts`.
4. Create the GitHub release from the reviewed commit with the matching tag shown above. Publish the server version before publishing a collector that depends on it.

## npm publication

The publish workflow runs only when a GitHub release is published and the repository variable `NPM_RELEASES_ENABLED` is `true`. It verifies the tag, runs the checks, and publishes with public access using npm trusted publishing (OIDC). Configure the trusted publisher before enabling the workflow; users installing the public package do not need credentials.

Manual publication is `npm publish --access public`; `prepublishOnly` runs the checks first. Merely changing `publishConfig.access` does not change an existing restricted npm package or GitHub repository's visibility. Existing package access and GitHub visibility must be changed at launch by a maintainer.

## Application and CDN deployment

Consumers can install a pinned public npm version or serve built browser files from
their own hosting. The documentation site at
[content-analytics.clearideas.com](https://content-analytics.clearideas.com/) is
deployed separately from `main`. See the [documentation deployment notes](docs/README.md#deployment).

## First public release

Use a reviewed source snapshot or a reviewed and sanitized history. Replacing an example key in current files does not remove historical copies or revoke that key. Verify that any previously embedded key is revoked or intentionally public and adequately restricted before publishing the old history. Keep private configuration, environment files, source-control metadata and generated release archives out of the public export.

## Stable release

Stable releases use the `latest` dist-tag. Prereleases use `next`. The collector publishes with an exact dependency on the corresponding server library version.

The release workflow uses npm trusted publishing (OIDC), with no publish token.
Configure the package's trusted publisher for the final Clear Ideas repository name
and `publish.yml`, allowing direct publish, before enabling `NPM_RELEASES_ENABLED`.
The GitHub repository name and package metadata must match that configuration.
If the package does not yet exist, the organization owner must complete the initial
package setup/publication using npm's supported interactive authentication, then
configure trusted publishing for later releases. See
https://docs.npmjs.com/trusted-publishers/.

AI review is optional and runs only with `AI_REVIEW_ENABLED=true`; clean installs,
builds and tests need only public npm dependencies and no Clear Ideas credentials.
