# Code signing policy

Free code signing, when active, is provided by SignPath.io with a certificate
issued to the SignPath Foundation.

## Current status

**No Windows artifact is currently signed.** The project applied to the
SignPath Foundation open-source program and was declined: the foundation grants
certificates when a project has established public visibility (stars, forks,
contributors, external references, sustained activity), and this project does
not meet that bar yet. The project will reapply once it does.

Until then:

- Artifacts on GitHub Releases are **unsigned**, and SmartScreen will warn on
  first run. This is expected behaviour for unsigned software.
- No release may be described as signed, and no one should claim that SignPath
  Foundation vouches for the current binaries.
- Verify downloads against the `sha512` in `latest.yml` — see
  [Verifying an unsigned release](#verifying-an-unsigned-release).

The workflow in `.github/workflows/release-signpath.yml` and the configuration
in [`signpath/`](./signpath/) are kept in the repository, dormant: they only run
via manual `workflow_dispatch` and require SignPath secrets that do not exist
yet. Once an application is approved, they become the release path, and Windows
will show **SignPath Foundation** as the publisher.

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

## Verifying an unsigned release

Unsigned builds cannot be verified by `Get-AuthenticodeSignature`, so compare
the file against the `sha512` published in `latest.yml` on the release page.
`latest.yml` stores Base64, while `Get-FileHash` prints hex; convert before
comparing:

```powershell
$f = ".\Qingframe-Setup-<version>-x64.exe"
$hex = (Get-FileHash -Algorithm SHA512 $f).Hash
$bytes = [byte[]]::new($hex.Length / 2)
for ($i = 0; $i -lt $hex.Length; $i += 2) {
    $bytes[$i / 2] = [Convert]::ToByte($hex.Substring($i, 2), 16)
}
[Convert]::ToBase64String($bytes)   # must equal the sha512 in latest.yml
```

Also check that the size matches the `size` field in `latest.yml`. If either
differs, do not run the file.

## Verifying a signed release

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
