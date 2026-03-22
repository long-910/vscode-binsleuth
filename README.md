# vscode-binsleuth

>  binary analysis — section map, section heatmap, and security flags right inside VS Code.

![vscode-binsleuth](https://repository-images.githubusercontent.com/1188141623/48b0a80f-364a-4652-98f3-bdbbc541c4ad)

<div align="center">

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC?style=flat-square)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/github/license/long-910/vscode-binsleuth?style=flat-square)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.85%2B-orange?style=flat-square&logo=rust)](https://www.rust-lang.org/)
[![binsleuth](https://img.shields.io/crates/v/binsleuth?style=flat-square&label=binsleuth&logo=rust)](https://crates.io/crates/binsleuth)
[![CI](https://github.com/long-910/vscode-binsleuth/actions/workflows/ci.yml/badge.svg)](https://github.com/long-910/vscode-binsleuth/actions/workflows/ci.yml)
[![Release](https://github.com/long-910/vscode-binsleuth/actions/workflows/release.yml/badge.svg)](https://github.com/long-910/vscode-binsleuth/actions/workflows/release.yml)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-pink?logo=github)](https://github.com/sponsors/long-910)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/long910)

🌐 [English](README.md) | [日本語](README.ja.md) | [中文](README.zh.md)

</div>

---

## Quick Start

**1. Build the Rust bridge** (one-time, requires Rust 1.85+)

```bash
git clone https://github.com/long-910/vscode-binsleuth.git
cd vscode-binsleuth
npm install
npm run build:rust      # compiles src-rust/ → bin/binsleuth-bridge
npm run compile         # compiles TypeScript
```

**2. Open the Extension Development Host**

Press **F5** in VS Code.
A new window opens with the extension active.

**3. Analyze a binary**

Open any `.elf`, `.exe`, `.dll`, `.so`, `.bin`, `.o`, `.a`, `.dylib`, or `.out` file —
the BinSleuth sidebar updates automatically.

> **Tip:** Click the crosshair icon (⊕) in the Activity Bar to open the BinSleuth panel at any time.

---

## What It Shows

```
Binary file  ──►  binsleuth-bridge (Rust)  ──►  JSON  ──►  Webview sidebar
                  · section info                           · Section Map
                  · Shannon entropy                        · Section Heatmap
                  · security flags                         · Security Score
                  · dangerous symbols                      · Dangerous Symbols
                                                      click any chart → jump to offset
```

The Rust bridge runs as a subprocess — **no network calls, no telemetry**.

---

## Features

### Section Map

A doughnut chart that shows how each section contributes to the binary's on-disk size.

- Neon-coloured arcs keyed by section type (`.text` green, `.data` cyan, `.bss` purple, …)
- Centre label: total file size and section count
- Hover tooltip: name · size · file offset · entropy · permissions (`RWX`)
- **Click any slice** → jumps to that section's offset in the Hex Editor (falls back to `vscode.open`)

### Section Heatmap

A horizontal bar chart that visualises **both size and entropy** of every section at once.

| Visual element | What it encodes |
|----------------|----------------|
| Bar length | Section size (x-axis in bytes) |
| Bar colour | Shannon entropy — cold blue (0 bits) → hot red (8 bits) |
| Number on bar | Exact entropy value |
| Neon glow | Entropy > 6.5 — likely packed or encrypted content |

A gradient colour legend (0 – 8 bits) is drawn above the chart for reference.

**Sort selector** (top-right of the panel):

| Option | Order |
|--------|-------|
| OFFSET ↑ | File offset, ascending (default) |
| SIZE ↓ / SIZE ↑ | Largest / smallest section first |
| ENTROPY ↓ / ENTROPY ↑ | Highest / lowest entropy first |
| NAME A-Z | Alphabetical |

**Click any bar** → jumps to that section's file offset.

### Security Flags Panel

At-a-glance hardening badges:

| Badge | Meaning |
|-------|---------|
| `NX` | Non-executable stack / DEP |
| `PIE` | Position-independent executable |
| `RELRO` | Relocation read-only (Full / Partial) |
| `CANARY` | Stack canary (`__stack_chk_fail`) |
| `FORTIFY` | FORTIFY_SOURCE |
| `STRIP` | Debug symbols stripped |

Colour coding: **green** = Enabled · **orange** = Partial · **red** = Disabled · **grey** = N/A

A **Security Score** (0–100) is shown in the header — higher is better.

### Dangerous Symbol Detection

If the binary imports symbols in high-risk categories (shell execution, network I/O, memory manipulation),
they are listed with their category tag directly in the sidebar.

### Auto-Detection

Opening any file with a recognised binary extension triggers analysis automatically.
No command needed.

---

## Usage

### Triggering Analysis

| How | When to use |
|-----|-------------|
| Open a binary file in the editor | Quickest — analysis starts automatically |
| Right-click file in Explorer → **BinSleuth: Analyze Binary** | Analyze without opening the file |
| **Ctrl+Shift+P** → **BinSleuth: Analyze Active File** | Re-analyze the currently focused file |

### Header Buttons

| Button | Action |
|--------|--------|
| **OPEN** | Open the analyzed binary in the Hex Editor (or default editor) |
| **EXPORT ▾** | Save a report — choose **Markdown**, **JSON**, or **CSV** |

### Navigating to a Section

Click any slice in the Section Map **or** any bar in the Section Heatmap.
If the [Hex Editor](https://marketplace.visualstudio.com/items?itemName=ms-vscode.hexeditor) extension is installed, the cursor jumps directly to the section's file offset.
Otherwise VS Code opens the file with `vscode.open`.

### Exporting a Report

1. Click **EXPORT ▾** in the sidebar header.
2. Choose the format: **Markdown** (human-readable), **JSON** (machine-readable), or **CSV** (spreadsheet).
3. A save dialog opens — pick the destination and save.

The report includes: binary metadata, per-section table (name · size · offset · entropy · permissions), security flags, and dangerous symbols.

---

## WSL / Windows Support

### VS Code running inside WSL (Remote - WSL)

Works out of the box.
The bridge binary is a Linux ELF (`bin/binsleuth-bridge`) invoked directly.

### VS Code running on Windows (native)

When the `win32-x64` VSIX (from GitHub Releases) is installed, the extension runs the native `binsleuth-bridge.exe` directly — **no WSL required**.

When built from source in WSL, the extension falls back to calling the Linux bridge via `wsl.exe`:

```
wsl.exe <wsl-path-to-bridge> <wsl-path-to-file>
```

| Scenario | Binary used | WSL required? |
|----------|-------------|:---:|
| Installed from `win32-x64` VSIX | `binsleuth-bridge.exe` (native) | No |
| Built locally from WSL, tested in Windows VS Code | `binsleuth-bridge` (Linux ELF via `wsl.exe`) | Yes |

---

## Installation

### Build from Source

```bash
git clone https://github.com/long-910/vscode-binsleuth.git
cd vscode-binsleuth
npm install
npm run build:rust      # Rust bridge → bin/binsleuth-bridge (Linux/macOS)
                        #             → bin/binsleuth-bridge.exe (Windows)
npm run compile         # TypeScript → out/
```

Press **F5** to launch an Extension Development Host.

### Build a VSIX (install into any VS Code)

```bash
npm install -g @vscode/vsce
npm run build           # build:rust + compile
vsce package            # → vscode-binsleuth-0.1.0.vsix
```

Install the `.vsix`:
**Extensions (Ctrl+Shift+X)** → **⋯** → **Install from VSIX…**

### Requirements

| Dependency | Version | Notes |
|-----------|---------|-------|
| VS Code | ≥ 1.85 | |
| Rust toolchain | ≥ 1.85 | Build only — not needed at runtime |
| [Hex Editor](https://marketplace.visualstudio.com/items?itemName=ms-vscode.hexeditor) | any | Optional — enables click-to-offset navigation |
| WSL (Windows only) | any | Required for native Windows VS Code |

---

## Development

```bash
# Watch TypeScript (auto-recompile on save)
npm run watch

# Rebuild Rust bridge after editing src-rust/
npm run build:rust

# Launch Extension Development Host
# → Press F5 in VS Code (config: .vscode/launch.json)
```

Project structure:

```
vscode-binsleuth/
├── src-rust/
│   ├── Cargo.toml          # binsleuth 0.4 + serde_json + anyhow
│   └── src/main.rs         # CLI: reads binary → JSON stdout
├── src/
│   ├── extension.ts        # activate(), commands, auto-detection, path normalization
│   └── panel.ts            # WebviewViewProvider + Webview HTML/CSS/JS
├── bin/                    # compiled bridge binary (git-ignored)
├── resources/
│   └── icon.svg            # Activity Bar icon
└── .vscode/
    ├── launch.json         # F5 debug config
    └── tasks.json          # TypeScript build task
```

The bridge outputs a single JSON object to stdout and exits.
The extension reads it via `child_process.execFile` and passes it to the Webview.

---

## Roadmap

| Feature | Status |
|---------|--------|
| Section Map (doughnut chart) | ✅ v0.1.0 |
| Section Heatmap (size + entropy, neon glow) | ✅ v0.1.0 |
| Security flags panel (NX / PIE / RELRO / …) | ✅ v0.1.0 |
| Security Score (0–100) | ✅ v0.1.0 |
| Dangerous symbol detection | ✅ v0.1.0 |
| Click-to-offset navigation | ✅ v0.1.0 |
| Auto-analysis on binary open | ✅ v0.1.0 |
| Export report (Markdown / JSON / CSV) | ✅ v0.1.0 |
| WSL / Windows-native VS Code support | ✅ v0.1.0 |
| VS Code Marketplace publication | 🔲 planned |
| Configurable bridge binary path | 🔲 planned |
| PE / Mach-O format badges | 🔲 planned |
| Diff view (compare two binaries) | 🔲 planned |

---

## Related Projects

- [BinSleuth](https://github.com/long-910/BinSleuth) — the underlying Rust analysis library
- [vscode-claude-status](https://github.com/long-910/vscode-claude-status) — Claude Code token usage in the VS Code status bar

---

## License

[MIT](LICENSE) — © 2026 long-910
