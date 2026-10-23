# Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Current status

The project is being prepared for SignPath Foundation signing. Until the first
signed release is published, Windows artifacts on GitHub Releases are unsigned
and must not be described as signed.

When signing is active, Windows shows **SignPath Foundation** as the publisher,
because the certificate is issued to the foundation rather than to this project.

## What is signed

Only Windows artifacts built by this repository's GitHub Actions workflow are
submitted for signing:

- `Qingframe-Setup-<version>-x64.exe`
- `Qingframe-Portable-<version>-x64.exe`
- `Qingframe.exe` inside the installed application

Third-party libraries and assets included in the packages are not signed by
this project. They remain under their upstream projects' terms. The NSIS
uninstaller generated at install time and helper executables such as
`elevate.exe` are not separately signed; the installer itself is signed.

## Build and signing process

1. A release build is produced by
   `.github/workflows/release-signpath.yml` on a GitHub-hosted
   `windows-latest` runner from `main`.
2. The unpacked `Qingframe.exe` is uploaded as a GitHub Actions artifact and
   submitted to SignPath.
3. After SignPath returns the signed executable, electron-builder packages the
   NSIS installer and portable executable from that signed directory.
4. The installer and portable executable are uploaded as a second artifact and
   signed by SignPath.
5. `latest.yml` and the NSIS `.blockmap` are regenerated from the signed
   installer, all signatures are verified, and a draft GitHub Release is
   created.
6. A maintainer verifies the draft artifacts, publishes the release, then
   checks the real old-version auto-update path (draft releases are not visible
   to electron-updater's `/releases/latest` endpoint).

Every signing request requires manual approval by the approver listed below.
The private key is held by SignPath in a hardware security module; it is never
stored in this repository or in GitHub Actions secrets.

SignPath may reject or refuse re-runs of old signing requests. If a signing
request expires or is denied, start a new workflow run instead of re-running an
old one.

## Team roles

This is a solo-maintained project. The maintainer holds all SignPath roles:

- **Authors / committers:** [@lumos-1s](https://github.com/lumos-1s)
- **Reviewers:** [@lumos-1s](https://github.com/lumos-1s)
- **Approvers:** [@lumos-1s](https://github.com/lumos-1s)

All maintainers with repository or signing access must use multi-factor
authentication for both GitHub and SignPath.

## Privacy

See [PRIVACY.md](./PRIVACY.md). Photos and project data are processed locally
and are not uploaded. The app checks GitHub Releases for updates and may contact
public GitHub proxy mirrors while checking. There is no analytics or telemetry.

## Verifying a release

For a signed release, all of the following should be true:

```powershell
Get-AuthenticodeSignature ".\Qingframe-Setup-<version>-x64.exe" |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

- `Status` is `Valid`.
- `SignerCertificate.Subject` starts with `CN=SignPath Foundation`.
- `TimeStamperCertificate` is present.

The same check applies to `Qingframe-Portable-<version>-x64.exe` and the
installed `Qingframe.exe`. If Windows shows "Unknown publisher" for a release
described here as signed, do not run it and report the issue.

## Signing configuration

The version-controlled SignPath artifact configurations are in
[`signpath/`](./signpath/). They are pasted into the SignPath project's Artifact
Configurations UI; SignPath does not read them from the repository at signing
time. See [`signpath/README.md`](./signpath/README.md) for the expected slugs and
repository secrets/variables.
