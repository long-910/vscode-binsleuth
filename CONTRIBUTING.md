# Contributing to vscode-binsleuth

Thank you for your interest in contributing!

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Rust](https://rustup.rs/) | ≥ 1.85 | Build the bridge binary |
| Node.js | ≥ 20 | TypeScript compilation |
| VS Code | ≥ 1.85 | Extension development |

## Development Setup

```bash
git clone https://github.com/long-910/vscode-binsleuth.git
cd vscode-binsleuth
npm install
npm run build:rust      # compile src-rust/ → bin/binsleuth-bridge
npm run compile         # compile TypeScript → out/
```

Press **F5** in VS Code to launch an Extension Development Host with the extension active.

## Development Workflow

```bash
# Watch TypeScript (auto-recompile on save)
npm run watch

# Rebuild Rust bridge after editing src-rust/
npm run build:rust

# Launch Extension Development Host
# → Press F5 in VS Code (config: .vscode/launch.json)
```

## Building a VSIX Package

```bash
npm install -g @vscode/vsce

# Linux / macOS — produces vscode-binsleuth-<version>.vsix
npm run package:vsix

# WSL → Windows: build and copy VSIX to Windows Downloads folder
npm run package:vsix-win
```

Install the `.vsix`:
**Extensions (Ctrl+Shift+X)** → **⋯** → **Install from VSIX…**

> **WSL note:** Windows VS Code cannot install a VSIX from a UNC path
> (`\\wsl.localhost\...`). Use `npm run package:vsix-win` to copy it to a
> Windows drive first.

## Project Structure

```
vscode-binsleuth/
├── src-rust/
│   ├── Cargo.toml          # binsleuth 0.4 + serde_json + anyhow
│   └── src/main.rs         # CLI: reads binary → JSON stdout
├── src/
│   ├── extension.ts        # activate(), commands, auto-detection, path normalization
│   └── panel.ts            # WebviewViewProvider + Webview HTML/CSS/JS + i18n
├── l10n/                   # Runtime translation bundles (ja, zh-cn)
├── bin/                    # Compiled bridge binary (git-ignored)
├── resources/
│   └── icon.svg            # Activity Bar icon
└── .vscode/
    ├── launch.json         # F5 debug config
    └── tasks.json          # TypeScript build task
```

## Architecture

```
Binary file  ──►  binsleuth-bridge (Rust subprocess)
                  · reads ELF / PE / Mach-O
                  · computes Shannon entropy per section
                  · evaluates security flags
                  └──► JSON to stdout

Extension (Node.js)
  child_process.execFile(bridge, [filePath])
  └──► parse JSON
  └──► webview.postMessage({ command: 'updateData', data })

Webview (HTML/CSS/JS + Chart.js)
  └──► renders Section Map, Section Heatmap, Security flags
```

No network calls. No telemetry. The bridge process exits after each analysis.

## Internationalization (i18n)

The extension uses the VS Code `vscode.l10n` API.

| File | Purpose |
|------|---------|
| `package.nls.json` | English extension metadata (baseline) |
| `package.nls.<locale>.json` | Translated metadata |
| `l10n/bundle.l10n.<locale>.json` | Translated runtime strings |

To add a new locale:
1. Add `package.nls.<locale>.json` at the root
2. Add `l10n/bundle.l10n.<locale>.json`
3. Add the language to all three README files

## Windows / WSL Development Notes

When testing in Windows-native VS Code from a WSL workspace:

| Bridge binary found | How it runs |
|---------------------|-------------|
| `bin/binsleuth-bridge.exe` | Direct execution (no WSL needed) |
| `bin/binsleuth-bridge` (Linux ELF) | Via `wsl.exe` (WSL must be installed) |

Build a Windows-native bridge with:
```bash
# From WSL, cross-compile for Windows (requires mingw or MSVC linker)
cd src-rust
cargo build --release --target x86_64-pc-windows-gnu
```

For full multi-platform releases, the GitHub Actions release workflow builds
each platform natively — see `.github/workflows/release.yml`.

## Releasing

1. Update `version` in `package.json`
2. Add an entry to `CHANGELOG.md` under `## [x.y.z]`
3. Push a tag: `git tag vX.Y.Z && git push origin vX.Y.Z`

GitHub Actions will:
- Build `binsleuth-bridge` for `linux-x64`, `darwin-x64`, `darwin-arm64`, `win32-x64`
- Package a platform-specific VSIX for each target
- Create a GitHub Release with all four VSIXs attached
- Publish to VS Marketplace if `MARKETPLACE_PUBLISH=true` (repo variable) and `VSCE_PAT` (repo secret) are set
