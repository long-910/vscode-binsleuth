# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-05-28

### Added

- Publish to [Open VSX Registry](https://open-vsx.org/extension/long-910/vscode-binsleuth) — the extension is now available for VS Code-compatible editors (VSCodium, Gitpod, etc.)
- CI job (`publish-ovsx`) in `release.yml` that automatically publishes all platform VSIXs to Open VSX on every stable tag release

## [0.1.0] - 2026-04-01

### Added

- Section Map — doughnut chart showing per-section on-disk size
- Section Heatmap — horizontal bar chart encoding both size and Shannon entropy
- Security Flags Panel — NX, PIE, RELRO, CANARY, FORTIFY, STRIP badges
- Security Score (0–100)
- Dangerous symbol detection (shell execution, network I/O, memory manipulation)
- Click-to-offset navigation via Hex Editor integration
- Auto-analysis on binary file open
- Export report (Markdown / JSON / CSV)
- Multi-OS support: Linux x64, macOS arm64/x64, Windows x64
- i18n: Japanese and Simplified Chinese
- VS Code Marketplace publication
