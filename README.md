# vscode-binsleuth

> Cyberpunk binary analysis — section map, entropy heatmap, and security flags right inside VS Code.

<div align="center">

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC?style=flat-square)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/github/license/long-910/vscode-binsleuth?style=flat-square)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.85%2B-orange?style=flat-square&logo=rust)](https://www.rust-lang.org/)
[![binsleuth](https://img.shields.io/crates/v/binsleuth?style=flat-square&label=binsleuth&logo=rust)](https://crates.io/crates/binsleuth)
[![CI](https://github.com/long-910/vscode-binsleuth/actions/workflows/ci.yml/badge.svg)](https://github.com/long-910/vscode-binsleuth/actions/workflows/ci.yml)
[![Release](https://github.com/long-910/vscode-binsleuth/actions/workflows/release.yml/badge.svg)](https://github.com/long-910/vscode-binsleuth/actions/workflows/release.yml)

</div>

## Overview

**vscode-binsleuth** is a Visual Studio Code extension that visualizes the internals of ELF / PE binaries without leaving your editor.

It uses a Rust-based analysis bridge powered by the [`binsleuth`](https://crates.io/crates/binsleuth) crate.
The bridge runs as a subprocess, analyzes the target binary, and streams a JSON report back to the extension.
A cyberpunk-themed Webview sidebar then renders the results with [Chart.js](https://www.chartjs.org/).

```
Binary file  ──►  binsleuth-bridge (Rust)  ──►  JSON  ──►  Webview (Chart.js)
                  sections · entropy               ▲         Section Map
                  security flags                   │         Entropy Heatmap
                  dangerous symbols                │         Security Flags
                                              click → jump to offset
```

> [!NOTE]
> The Rust bridge binary must be compiled once before first use.
> Run `npm run build:rust` in the project root.
> After that, the extension automatically locates the binary and works offline — no network calls, no telemetry.

---

## Features

### Section Map

A doughnut chart showing how each section contributes to the overall binary size.

- Neon-coloured arcs keyed by section type (`.text` green, `.data` cyan, `.bss` purple, …)
- Centre label shows total on-disk size and section count
- Hover tooltip: name, size, file offset, entropy, permissions (`RWX`)
- **Click any slice** → jumps to that section's file offset in the Hex Editor (falls back to a standard `vscode.open`)

### Entropy Heatmap

A horizontal bar chart with sections sorted by file offset.

- Each bar's colour encodes Shannon entropy on a cold–hot scale:
  `blue (0) → cyan → green → orange → red (8)`
- Sections with entropy > 7.0 are a strong indicator of packed or encrypted content
- **Click any bar** → jumps to that section's offset

### Security Flags Panel

At-a-glance badges for all hardening properties detected by `binsleuth`:

| Badge | Meaning |
|-------|---------|
| `NX` | Non-executable stack / DEP |
| `PIE` | Position-independent executable |
| `RELRO` | Relocation read-only (Full / Partial) |
| `CANARY` | Stack canary (`__stack_chk_fail`) |
| `FORTIFY` | FORTIFY_SOURCE |
| `STRIP` | Debug symbols stripped |

Colour coding: green = Enabled, orange = Partial, red = Disabled, grey = N/A.

### Dangerous Symbol Detection

If the binary imports symbols in high-risk categories (shell execution, network I/O, memory manipulation),
they are listed below the security flags panel.

### Auto-Detection

Opening a file with any of the following extensions automatically triggers analysis:

`.elf` `.exe` `.dll` `.so` `.bin` `.o` `.a` `.dylib` `.out`

---

## Architecture

| Layer | Language | Key dependencies |
|-------|----------|-----------------|
| Analysis bridge | Rust | [`binsleuth 0.4`](https://crates.io/crates/binsleuth), `serde_json`, `anyhow` |
| Extension host | TypeScript | VS Code API (`^1.85`), `child_process` |
| Webview UI | HTML / JS | [Chart.js 4.4](https://www.chartjs.org/) (CDN) |

The bridge binary is invoked via `child_process.execFile` with the target file path as the sole argument.
It writes a single JSON object to stdout and exits:

```jsonc
{
  "file": "/path/to/binary",
  "sections": [
    {
      "name": ".text",
      "size": 98304,
      "virtual_address": 4096,
      "file_offset": 4096,
      "entropy": 5.821,
      "permissions": { "read": true, "write": false, "execute": true }
    }
    // …
  ],
  "security": {
    "format": "ELF",
    "architecture": "x86_64",
    "nx": "Enabled",
    "pie": "Enabled",
    "relro": "Enabled",
    "canary": "Enabled",
    "fortify": "Disabled",
    "rpath": "N/A",
    "stripped": "Enabled",
    "dangerous_symbols": []
  },
  "security_score": 100,
  "total_virtual_size": 204800,
  "total_file_size": 163840
}
```

---

## Requirements

- **VS Code** 1.85 or newer
- **Rust toolchain** 1.85 or newer (for building the bridge)
- **[Hex Editor](https://marketplace.visualstudio.com/items?itemName=ms-vscode.hexeditor)** *(optional)* — enables click-to-offset navigation inside the binary

---

## Installation

### Build from Source

```bash
git clone https://github.com/long-910/vscode-binsleuth.git
cd vscode-binsleuth
npm install
npm run build:rust      # compile the Rust bridge (one-time)
npm run compile         # compile TypeScript
```

Then press **F5** in VS Code to launch an Extension Development Host.

### Build a VSIX

```bash
npm install -g @vscode/vsce
npm run build           # build:rust + compile
vsce package            # → vscode-binsleuth-*.vsix
```

Install the generated `.vsix`:
**Extensions (Ctrl+Shift+X)** → **⋯** → **Install from VSIX…**

---

## Usage

| Action | Result |
|--------|--------|
| Open a binary file (`.elf`, `.exe`, …) | Analysis runs automatically |
| Right-click file in Explorer → **BinSleuth: Analyze Binary** | Analyze any file |
| **Ctrl+Shift+P** → **BinSleuth: Analyze Active File** | Analyze the active editor |
| Click a section in the Section Map | Jump to its offset + show detail card |
| Click a bar in the Entropy Heatmap | Jump to that section's offset |

The BinSleuth sidebar is accessible from the activity bar (targeting-reticle icon).

---

## Development

```bash
# Watch TypeScript
npm run watch

# Rebuild Rust bridge after editing src-rust/
npm run build:rust

# Run Extension Development Host
# → Press F5 in VS Code (uses .vscode/launch.json)
```

Project structure:

```
vscode-binsleuth/
├── src-rust/
│   ├── Cargo.toml          # binsleuth + serde_json + anyhow
│   └── src/main.rs         # CLI: reads binary → JSON stdout
├── src/
│   ├── extension.ts        # activate(), commands, file watcher
│   └── panel.ts            # WebviewViewProvider + full Webview HTML/JS
├── resources/
│   └── icon.svg            # Activity bar icon
└── .vscode/
    ├── launch.json         # F5 debug config
    └── tasks.json          # TypeScript build tasks
```

---

## Roadmap

| Feature | Status |
|---------|--------|
| Section Map (doughnut chart) | ✅ v0.1.0 |
| Entropy Heatmap (horizontal bar) | ✅ v0.1.0 |
| Security flags panel (NX/PIE/RELRO/Canary/…) | ✅ v0.1.0 |
| Dangerous symbol detection | ✅ v0.1.0 |
| Click-to-offset navigation | ✅ v0.1.0 |
| Auto-analysis on binary file open | ✅ v0.1.0 |
| VS Code Marketplace publication | 🔲 planned |
| Configurable bridge binary path | 🔲 planned |
| PE / Mach-O format badges | 🔲 planned |
| Diff view (compare two binaries) | 🔲 planned |

---

## Related Projects

- [BinSleuth](https://github.com/long-910/BinSleuth) — the underlying Rust analysis library (same author)
- [vscode-claude-status](https://github.com/long-910/vscode-claude-status) — Claude Code token usage in the VS Code status bar (same author)

---

## License

[MIT](LICENSE) — © 2026 long-910
