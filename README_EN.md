<div align="center">

<img src="docs/images/logo.png" alt="MeTerm Logo" width="128">

# MeTerm

**Cross-platform terminal for local, SSH and JumpServer sessions**

[![CI](https://github.com/mj915908848/MeTerm/actions/workflows/ci.yml/badge.svg)](https://github.com/mj915908848/MeTerm/actions/workflows/ci.yml)
[![Build macOS](https://github.com/mj915908848/MeTerm/actions/workflows/build-macos.yml/badge.svg)](https://github.com/mj915908848/MeTerm/actions/workflows/build-macos.yml)
[![Build Windows](https://github.com/mj915908848/MeTerm/actions/workflows/build-windows.yml/badge.svg)](https://github.com/mj915908848/MeTerm/actions/workflows/build-windows.yml)

[MIT License](LICENSE) · [Latest release](https://github.com/mj915908848/MeTerm/releases/latest) · [All releases](https://github.com/mj915908848/MeTerm/releases)

[中文](./README.md) · [Download](#download) · [Quick Start](#quick-start) · [Docs](#documentation) · [Acknowledgements](#acknowledgements)

</div>

---

## Screenshots

| Terminal | Split Pane |
|:---:|:---:|
| ![terminal](docs/images/terminal.png) | ![split-pane](docs/images/split-pane.png) |

| SFTP File Manager | Home Search |
|:---:|:---:|
| ![file-manager](docs/images/file-manager.png) | ![home-search](docs/images/home-search.png) |

| JumpServer Asset Browser | JumpServer Terminal | JumpServer File Manager |
|:---:|:---:|:---:|
| ![jumpserver-browser](docs/images/jumpserver-3.png) | ![jumpserver-terminal](docs/images/jumpserver-2.png) | ![jumpserver-files](docs/images/jumpserver-1.png) |

| AI Assistant | Settings |
|:---:|:---:|
| ![ai-capsule](docs/images/ai-capsule.png) | ![settings](docs/images/settings.png) |

---

## Key Features

**Three session types:**

- **Local Terminal** — Out-of-the-box local shell sessions
- **SSH Remote** — Password/key authentication to remote servers
- **JumpServer** — Browse and connect bastion host assets (tested v2 & v4, supports MFA authentication)

To bring in existing SSH hosts, open **Settings › Connections › Import & Export › Import OpenSSH config** and select your `~/.ssh/config`. The importer previews named hosts with a `User` setting and skips saved names. It accepts `Host`, `HostName`, `User`, `Port`, and one `IdentityFile` per host. Entries that require a jump host or multiple identity files are skipped. `Include` and `Match` are currently unsupported.

**Tab management:**

- Multi-tab with drag-to-reorder, drag tab out to create new window
- Split pane layout (horizontal/vertical, independent sessions per pane)
- Connection quick switcher (Cmd+Shift+O on macOS, Ctrl+Shift+O on Windows)

**Terminal enhancements:**

- AI Assistant & Agent — Floating dialog or side panel, supports OpenAI-compatible / Anthropic / Gemini protocols; Agent mode adds multi-pane awareness, file transfer, task planning, structured search, and per-session PTY lock
- SFTP File Manager — Breadcrumb navigation, keyboard nav, file search, multi-select, remote copy/move, chmod, bookmarks, speed limit, transfer notifications, drag-and-drop, resume, parallel high-speed transfers via adaptive SFTP pipeline
- Built-in Editor — Remote file editing, Markdown preview, image preview, word wrap, multi-format formatting (JSON/XML/HTML/CSS)
- Shell Hook Integration — OSC 7766/7768 semantic prompts: click-to-move cursor, drag-select-to-edit in command area; automatic fallback when hook is unavailable
- Command completion & tldr help cards
- **Find in terminal** — Search the active pane's output with Cmd+F on macOS or Ctrl+Shift+F on Windows. Supports regex and case-sensitive matching.
- **Command snippets** — Manage reusable commands in Settings › Terminal › Snippets. Open the palette with Cmd/Ctrl+Shift+S to insert or run a snippet.
- **Synced input across panes** — Toggle with Cmd/Ctrl+Shift+I to send typing and pastes to all panes in the current tab. Highlighted borders show when it is active.
- Home quick search — Local commands + web search (requires self-hosted [SearXNG](https://github.com/searxng/searxng))
- Themes & Backgrounds — 8 terminal color themes and customizable background images
- Terminal font enhancements — Font weight control, text sharpening, font size shortcuts (Ctrl/Cmd +/-)

**Networking:**

- Auto-reconnection — Ring buffer for missed data

**Other:**

- Windows right-click menu integration (Open in MeTerm)
- Clickable file paths in terminal output (open files/folders directly)
- SSH proxy support — SOCKS5 / HTTP CONNECT, independent proxy config per JumpServer
- OSC enhancements — OSC 52 clipboard passthrough, OSC 8 hyperlinks, image display protocol
- Chrome-style tab switching shortcuts (Ctrl/Cmd 1-9)
- Window always-on-top pin button
- Auto-create local session on startup (optional)
- Internationalization (EN/ZH) · Desktop notifications

---

## Platform Support

| Platform | Architecture | Requirements |
|----------|-------------|--------------|
| macOS | Apple Silicon (arm64) | macOS 14 or later |
| macOS | Intel (x86_64) | macOS 14 or later |
| Windows | x64 | [Windows requirements](WINDOWS.md#runtime-requirements--运行要求) |

---

## Download

[Download the latest installers](https://github.com/mj915908848/MeTerm/releases/latest)

| Platform | Installer |
|----------|-----------|
| macOS (Apple Silicon) | `MeTerm_x.x.x_aarch64.dmg` |
| macOS (Intel) | `MeTerm_x.x.x_x64.dmg` |
| Windows (x64) | `MeTerm_x.x.x_x64-setup.exe` |

To upgrade from [v0.4.1](https://github.com/mj915908848/MeTerm/releases/tag/v0.4.1), download the installer from Releases. Starting with v0.4.2, you can check for subsequent releases inside the app.

### macOS blocks the first launch

Unless built with paid Apple Developer ID signing and notarization secrets in CI,
macOS builds published from this repository are **not Developer ID signed and not
notarized** (that requires a paid Apple Developer Program membership, ¥688/year).
Gatekeeper therefore blocks the first launch with a "developer cannot be verified"
message. **The download is not corrupt.** Do the following once and the app behaves
normally afterwards.

**Install**

Open the dmg and drag `MeTerm.app` onto the `Applications` shortcut in the same
window. That is the whole installation — no installer script is involved.

**Then allow the first launch** — either way works:

*Option 1 — System Settings (no Terminal)*

1. Double-click MeTerm in Applications and dismiss the warning with **Done**
2. Open **System Settings → Privacy & Security** and scroll to **Security**
3. Click **Open Anyway** next to the MeTerm notice, then authenticate
4. Double-click the app again

> Since macOS 15 (Sequoia) Apple **removed the old right-click → Open override**.
> Most tutorials still recommend it, but it no longer works.

*Option 2 — one command*

```bash
xattr -cr "/Applications/MeTerm.app"
```

> The image deliberately contains **no helper script**. A helper only runs when
> double-clicked from inside the mounted window, and that path cannot be verified
> before shipping — on a real Mac it is blocked by Gatekeeper with no way through.
> Since it cannot be verified, it should not be the install path: the standard
> drag-to-Applications flow above is the supported one.

**Keychain password prompts after every upgrade**

Saved SSH passwords live in the Keychain, one item per connection. An ad-hoc
signed build is recognised by the Keychain only through its binary hash, which
changes every release, so each connection asks for the login password again
after an upgrade. A maintainer can export any code-signing certificate (the free
Apple Development one is enough) as `.p12` and set the repository secrets
`MACOS_STABLE_SIGN_CERTIFICATE` (base64 of the p12) and
`MACOS_STABLE_SIGN_CERTIFICATE_PASSWORD`. Without a Developer ID, CI then signs
with that certificate (not notarized, so the first-launch approval above still
applies). On the first launch after the switch each connection asks one last
time; choose **Always Allow** and later upgrades stop asking.

---

## Quick Start

### Prerequisites

| Dependency | Version | Installation |
|------------|---------|-------------|
| **Node.js** | 22 (22.6 or later for tests) | [Download Node.js](https://nodejs.org/) |
| **Rust** | latest stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Make** | — | macOS built-in |

### Development Setup

Both `make desktop-dev` and `make desktop-run-dev` require a usable Apple Development signing identity in the local Keychain. Create one in Xcode if needed. Use [the Windows development guide](WINDOWS.md#development-and-build-requirements--开发与构建要求) for the WSL-based workflow.

```bash
# Clone the repository
git clone https://github.com/mj915908848/MeTerm.git
cd MeTerm

# Install desktop frontend dependencies
cd desktop && npm ci && cd ..

# Start desktop app in dev mode
make desktop-dev
```

Use `make desktop-dev` for hot reload. To test the signed debug bundle or
development credential recovery, launch the isolated MeTerm Dev app:

```bash
make desktop-run-dev              # Builds/signs and opens MeTerm Dev.app (com.meterm.dev)
```

This target never opens or overwrites an installed production `MeTerm.app`.
Use the same signing identity on later rebuilds so development Keychain access
continues to match the app's designated requirement.

The expected signer common name and team ID are resolved from the local
keychain at build time (`scripts/dev-relay-provenance.sh`) and injected as
`METERM_DEV_SIGNER_CN` / `METERM_DEV_TEAM_ID`, so neither the personal Apple ID
embedded in the certificate name nor the account's team ID is committed to the
repository. Both targets resolve the signing identity before calling Tauri
and stop if it is unavailable. To check the selected identity or specify a
different certificate, use the following commands.

```bash
bash scripts/dev-relay-provenance.sh --check
METERM_DEV_SIGNER_CN='Apple Development: you@example.com (XXXXXXXXXX)' make desktop-dev
```

`desktop-build-dev` is the only supported target that enables the
`development-credential-recovery` feature (together with
`development-mobile-control`). The feature is rejected in Release builds and
the import command additionally verifies the exact signed `MeTerm Dev.app`
identity before it can run.

`MeTerm Dev` never scans the production Keychain at startup. To recover one
missing development credential, right-click that saved SSH connection and use
the development-only import action. Only that connection's exact authority is
shown in the native owner-presence prompt. In any macOS Keychain dialog choose
**Allow**, never **Always Allow**. This action may read only the quarantined
production `com.meterm.app.ssh.v2` item and can never read the clean production
v3 vault. A bound v2 item must match the authority; an unbound v2 item is bound
only after the explicit owner confirmation describing that possibility. The
source remains unchanged, the copy is written to the isolated Dev service,
cancellation is not retried on a later launch, and normal Dev runtime never
falls back to a production vault. Desktop private-key paths are deliberately
not copied from v2; reselect the file locally so the native confirmation can
show the exact normalized path. A desktop key-ladder grant copies no production
secret bytes and writes only a fresh authority marker after owner confirmation.

Normal startup also does not open Keychain for old localStorage/name-keyed SSH,
Remote, JumpServer, or settings credentials. It only inspects Web Storage and
records redacted pending/manual/complete states or a non-secret presence cache.
Re-save the corresponding connection/settings when needed. Until the formal,
owner-confirmed recovery UI is implemented, old credentials are not claimed as
recoverable by the distributed app.

Windows development (from WSL):

```bash
make desktop-dev-win              # Start dev
```

<details>
<summary><b>Build Installers</b></summary>

#### macOS

```bash
make release-macos                # Current architecture
make release-macos-arm64          # Apple Silicon
make release-macos-x86_64         # Intel
make release-macos-all            # Build both architectures

# Code signing uses an existing local Keychain identity; it never exports the private key.
APPLE_SIGNING_IDENTITY='Developer ID Application: …' \
  ./build-macos.sh --arch arm64 --sign

# Notarization additionally requires APPLE_API_KEY_ID, APPLE_API_ISSUER_ID,
# and APPLE_API_KEY_PATH pointing to a local App Store Connect .p8 file.
APPLE_SIGNING_IDENTITY='Developer ID Application: …' \
  ./build-macos.sh --arch arm64 --sign --notarize
```

#### Windows

```bash
make desktop-build-win            # One-click build from WSL
```

#### Generic

```bash
make desktop-build                # Tauri production build (current platform)
```

</details>

---

## Architecture

Since v0.2.0, MeTerm has migrated from a Go sidecar architecture to a **pure Rust in-process backend**, eliminating external process management and inter-process communication overhead.

```text
MeTerm/
├── desktop/              # Tauri v2 desktop app
│   ├── src/              #   Frontend TypeScript (220+ modules)
│   │   ├── ai-*          #     AI assistant (floating dialog, tools, agent, audit log)
│   │   ├── file-*        #     SFTP file manager & built-in editor
│   │   ├── session*      #     Session management (Tauri IPC)
│   │   ├── terminal-*    #     Terminal instances & IPC transport
│   │   ├── split-pane*   #     Split pane layout
│   │   └── ...
│   ├── tests/            #   Frontend unit & regression tests (.test.mts)
│   └── src-tauri/        #   Rust backend
│       └── src/
│           ├── commands/  #     Tauri IPC commands (terminal Channel, session, window, menu, AI, etc.)
│           └── server/    #     In-process backend (session manager, PTY/SSH, local HTTP for JumpServer)
│               ├── session/    # Session state machine & manager
│               ├── terminal/   # Cross-platform PTY (Unix/Windows/WSL/SSH)
│               ├── executor/   # Local & SSH executors
│               ├── jumpserver/ # JumpServer asset browser
│               ├── dispatch/   # Binary protocol message routing
│               ├── file_handler/ # File transfer (SFTP adaptive pipeline)
│               ├── auth        # Bearer token & loopback origin authentication
│               └── ...
├── docs/                 # API, protocol & configuration docs
└── scripts/              # Build & dev signing helper scripts
```

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Backend** | Rust, Axum, Tokio, xpty (cross-platform PTY), russh / russh-sftp (SSH terminal and file transfer) |
| **Frontend** | TypeScript, Vite, xterm.js 5.x, CodeMirror 6 |
| **Desktop** | Tauri v2 (Rust + TypeScript), reqwest, keyring |
| **Update (`main`)** | `tauri-plugin-updater` reads GitHub Releases `latest.json` and verifies update package signatures |

### Architecture Highlights

- **Single-process** — Backend server runs in-process via Tokio, no external sidecar management
- **Cross-platform PTY** — Unified abstraction over Unix PTY, Windows ConPTY, WSL, and SSH
- **Session state machine** — Created → Running → Draining (with ring buffer) → Closed, supporting seamless reconnection
- **Binary protocol** — Custom binary messaging over Tauri IPC for efficient terminal I/O
- **Adaptive SFTP pipeline** — Dynamic window scaling (2→64) based on RTT for high-throughput file transfers
- **Desktop SSH transfer backend** — Desktop SSH uploads and downloads can use a dedicated native transfer path to avoid terminal-path bottlenecks

---

## Documentation

| Document | Description |
|----------|-------------|
| [REST API Reference](docs/API.md) | Loopback HTTP routes, authentication, and saved SSH connection errors |
| [Binary Protocol](docs/PROTOCOL.md) | Terminal binary protocol spec |
| [Configuration](docs/CONFIGURATION.md) | Server defaults, client settings, and session roles |
| [Windows Guide](WINDOWS.md) | Windows requirements, development, and packaging |

---

## Contributing

Issues and Pull Requests are welcome!

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## Acknowledgements

MeTerm is built on top of many excellent open-source projects. Thanks to all contributors!

See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for full third-party license details.

---

## License

[MIT License](LICENSE)
