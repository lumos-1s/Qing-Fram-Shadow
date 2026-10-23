# Privacy policy

清框影 / QingFramShadow is a local-first Windows desktop application.

## Photos and project data

- Photos, edited images, presets, signatures, avatars, and project files are
  processed and stored on your computer.
- The application does not upload your photos or project data to this project's
  servers.
- There is no account, login, analytics, or telemetry.

## Network connections

The application checks GitHub Releases for updates:

- On startup (after a short delay), and when you choose "check for updates".
- It requests release metadata from
  `https://github.com/lumos-1s/Qing-Fram-Shadow-web/releases`.
- To find a working source, it may also contact the public mirrors
  `https://ghproxy.net`, `https://ghfast.top`, and `https://gh-proxy.com`, as
  configured in `src/main/index.js`. You can override the mirror with the
  `QINGFRAME_PROXY` environment variable.
- Update downloads are requested only after you choose to download an update.
- These requests are subject to GitHub's and the mirror operators' privacy
  policies.

External links are opened only when you choose them.

## Local storage

Settings, templates, cached update files, and other application data are stored
in the Electron user-data directory on your computer. Uninstalling the
application may leave user-created files and settings behind; remove them
manually if you want a complete cleanup.

## Contact

Privacy questions can be raised at
<https://github.com/lumos-1s/Qing-Fram-Shadow-web/issues>.

Except for the update checks described above, this program will not transfer
any information to other networked systems unless specifically requested by the
user or the person installing or operating it.
