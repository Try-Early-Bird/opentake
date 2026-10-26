# Releasing

For maintainers. Everyday development needs none of this.

## Versions

`package.json` is the version source. Update it and the lockfile together, then
tag the commit with the matching version:

```sh
npm version 0.3.0-beta.1 --no-git-tag-version
git commit -am "Release 0.3.0-beta.1"
git tag v0.3.0-beta.1 && git push origin main v0.3.0-beta.1
```

Preview channels are `alpha`, `beta` and `rc`. Never move a published tag.

## Release drafts

Pushing a `v*` tag runs `.github/workflows/release.yml`. It rejects versions
that disagree with either lockfile version, runs the full checks, builds signed
installers and creates an **unpublished draft** in this repository with the
installers, blockmaps, merged update YAML and `SHA256SUMS`. It never publishes
and never overwrites an existing release; delete an incomplete draft by hand
before rerunning.

Tag pushes build macOS only (arm64 and x64, one merged update feed). A manual
run against a tag can choose `platforms: all` to add Windows x64; set the
repository variable `DESKTOP_RELEASE_PLATFORMS` to `all` to make that the
default.

`npm run build:release` uses `electron-builder.release.cjs`. Compared with
`build:prod` it requires code signing and Apple notarization, turns on Electron's
hardening fuses (see [security-model.md](security-model.md#signed-releases)),
signs macOS without the `disable-library-validation` entitlement, and enables
in-app updates from `Try-Early-Bird/opentake-releases`.

### Secrets

Configure the `desktop-release` environment:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application certificate (.p12) |
| `MAC_CSC_KEY_PASSWORD` | Its password |
| `APPLE_API_KEY_P8` | App Store Connect Team API private key (.p8), with PEM headers |
| `APPLE_API_KEY_ID` | API key ID |
| `APPLE_API_ISSUER` | Team API issuer UUID (not the Team ID) |
| `WIN_CSC_LINK` | Windows code-signing certificate (.pfx), base64; `all` only |
| `WIN_CSC_KEY_PASSWORD` | Its password |

Create the Team API key under App Store Connect → Users and Access →
Integrations → Team Keys, with App Manager access. CI writes it to a restricted
temporary file and deletes it when the build step exits. Protect the release
environment and restrict who can push version tags: tagged code runs with
signing access.

## Publishing installers

Installers and update feeds are published from the installers-only repository
`Try-Early-Bird/opentake-releases`, which the app's update checker reads. Do not
push source there. Download the draft's installers, blockmaps, update YAML and
`SHA256SUMS`, verify the checksums, upload them to a matching draft there, and
publish it after acceptance testing.

## Acceptance before publishing

Automated tests cannot establish these; check them by hand on each architecture:

- clean install, and an upgrade from the previous signed version;
- the update notice, download and restart;
- database, settings and saved sign-ins survive the upgrade (OS keychain access);
- launch at login;
- a migration failure leaves the previous database active.

## Updates and recovery

Packaged apps check for updates 30 seconds after launch and every six hours.
Nothing downloads or installs without the user's action, and installation waits
for active chats, connection work, imports and trades. The background host
drains work, closes the database and writes a shutdown receipt before the
installer runs.

Schema upgrades migrate a separate copy; only a fully migrated copy becomes
active, and the previous database stays in the profile for recovery. Do not
reinstall an older build after a schema upgrade: older schemas fail closed.
Recover with an encrypted backup import instead.
