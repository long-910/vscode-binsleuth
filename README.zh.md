# vscode-binsleuth

> 在 VS Code 侧边栏中直接查看节区图、熵热图和安全标志的二进制分析扩展。

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

## 截图

![BinSleuth 演示](images/demo.png)

---

## 功能概览

```
二进制文件 ──► binsleuth-bridge（Rust）──► JSON ──► Webview 侧边栏
               · 节区信息                           · 节区图
               · Shannon 熵                         · 节区热图
               · 安全标志                            · 安全评分
               · 危险符号                            · 危险符号列表
                                              点击图表 → 跳转到偏移量
```

Rust 桥接程序作为子进程运行 — **无网络请求，无遥测数据。**

---

## 功能详情

### 节区图

以环形图展示每个节区在磁盘上占用的大小比例。

- 按节区类型分配霓虹色弧段（`.text` 绿色、`.data` 青色、`.bss` 紫色等）
- 中央标签：文件总大小和节区数量
- 悬停提示：名称·大小·文件偏移量·熵值·权限（RWX）
- **点击任意扇区** → 在 Hex Editor 中跳转到该节区的偏移量

### 节区热图

以水平条形图同时可视化每个节区的**大小和熵值**。

| 视觉元素 | 编码信息 |
|---------|---------|
| 条形长度 | 节区大小（x 轴，字节） |
| 条形颜色 | Shannon 熵 — 冷蓝（0 位）→ 热红（8 位） |
| 条形上的数字 | 精确熵值 |
| 霓虹光晕 | 熵值 > 6.5 — 可能已压缩或加密 |

图表上方绘制梯度颜色图例（0–8 位）以供参考。

**排序选择器**（面板右上角）:

| 选项 | 顺序 |
|------|------|
| 偏移量 ↑ | 文件偏移量升序（默认） |
| 大小 ↓ / ↑ | 最大 / 最小节区优先 |
| 熵值 ↓ / ↑ | 最高 / 最低熵值优先 |
| 名称 A-Z | 字母顺序 |

**点击任意条形** → 跳转到该节区的文件偏移量。

### 安全标志面板

一览式加固徽章：

| 徽章 | 含义 |
|------|------|
| `NX` | 不可执行栈 / DEP |
| `PIE` | 位置无关可执行文件 |
| `RELRO` | 重定位只读（Full / Partial） |
| `CANARY` | 栈金丝雀（`__stack_chk_fail`） |
| `FORTIFY` | FORTIFY_SOURCE |
| `STRIP` | 已去除调试符号 |

颜色编码：**绿色** = 已启用 · **橙色** = 部分 · **红色** = 已禁用 · **灰色** = 不适用

标题栏显示**安全评分**（0–100），分数越高越安全。

### 危险符号检测

若二进制文件导入了高风险类别的符号（shell 执行、网络 I/O、内存操作），
将在侧边栏中直接列出这些符号及其类别标签。

### 自动检测

打开具有已知二进制扩展名的文件时，自动触发分析。
无需执行任何命令。

---

## 使用方法

### 触发分析

| 方式 | 适用场景 |
|------|---------|
| 在编辑器中打开二进制文件 | 最快捷 — 自动开始分析 |
| 在资源管理器中右键点击文件 → **BinSleuth: 分析二进制文件** | 无需打开文件即可分析 |
| **Ctrl+Shift+P** → **BinSleuth: 分析当前文件** | 重新分析当前聚焦的文件 |

### 标题栏按钮

| 按钮 | 操作 |
|------|------|
| **打开** | 在 Hex Editor（或默认编辑器）中打开已分析的二进制文件 |
| **导出 ▾** | 保存报告 — 选择 **Markdown**、**JSON** 或 **CSV** |

### 导航到节区

点击节区图中的任意扇区**或**节区热图中的任意条形。
若已安装 [Hex Editor](https://marketplace.visualstudio.com/items?itemName=ms-vscode.hexeditor) 扩展，光标将直接跳转到该节区的文件偏移量。
否则将使用 `vscode.open` 打开文件。

### 导出报告

1. 点击侧边栏标题栏中的 **导出 ▾**。
2. 选择格式：**Markdown**（人类可读）、**JSON**（机器可读）或 **CSV**（电子表格）。
3. 保存对话框打开后，选择目标位置并保存。

报告包含：二进制元数据、各节区表格（名称·大小·偏移量·熵值·权限）、安全标志和危险符号。

---

## WSL / Windows 支持

| 场景 | 是否需要 WSL |
|------|:-----------:|
| WSL 内的 VS Code（Remote - WSL） | 不需要 |
| Windows VS Code 使用 `win32-x64` VSIX | 不需要 |
| 在 WSL 中从源码构建，在 Windows VS Code 中使用 | 需要 |

---

## 安装

### VS Code Marketplace（推荐）

1. 在 VS Code 中打开**扩展**（`Ctrl+Shift+X`）。
2. 搜索 **BinSleuth**。
3. 点击**安装**。

或直接从 [VS Code Marketplace 页面](https://marketplace.visualstudio.com/items?itemName=long-910.vscode-binsleuth) 安装。

### 从 GitHub Releases 下载

如需特定平台的构建版本，可从 [Releases 页面](https://github.com/long-910/vscode-binsleuth/releases) 下载 VSIX：

| 文件 | 平台 |
|------|------|
| `*-linux-x64.vsix` | Linux x64 |
| `*-darwin-arm64.vsix` | macOS Apple Silicon |
| `*-darwin-x64.vsix` | macOS Intel |
| `*-win32-x64.vsix` | Windows x64 |

安装：**扩展（Ctrl+Shift+X）** → **⋯** → **从 VSIX 安装…**

> **Windows 用户注意：** 请先将 `.vsix` 保存到 Windows 本地驱动器（例如 `C:\Users\...\Downloads\`）再安装 — VS Code 无法从 WSL UNC 路径安装。

### 依赖要求

| 依赖 | 版本 | 备注 |
|------|------|------|
| VS Code | ≥ 1.85 | |
| [Hex Editor](https://marketplace.visualstudio.com/items?itemName=ms-vscode.hexeditor) | 任意 | 可选 — 启用点击偏移量导航 |
| WSL（仅 Windows） | 任意 | 非 `win32-x64` VSIX 场景下需要 |

---

## 路线图

| 功能 | 状态 |
|------|------|
| 节区图（环形图） | ✅ v0.1.0 |
| 节区热图（大小 + 熵值，霓虹光晕） | ✅ v0.1.0 |
| 安全标志面板（NX / PIE / RELRO / …） | ✅ v0.1.0 |
| 安全评分（0–100） | ✅ v0.1.0 |
| 危险符号检测 | ✅ v0.1.0 |
| 点击偏移量导航 | ✅ v0.1.0 |
| 打开二进制文件时自动分析 | ✅ v0.1.0 |
| 导出报告（Markdown / JSON / CSV） | ✅ v0.1.0 |
| 多平台支持（Windows 原生、macOS、Linux） | ✅ v0.1.0 |
| 多语言支持（日语·中文） | ✅ v0.1.0 |
| 发布到 VS Code Marketplace | ✅ v0.1.0 |
| 可配置桥接二进制路径 | 🔲 计划中 |
| PE / Mach-O 格式徽章 | 🔲 计划中 |
| 差异视图（比较两个二进制文件） | 🔲 计划中 |

---

## 相关项目

- [BinSleuth](https://github.com/long-910/BinSleuth) — 底层 Rust 分析库
- [vscode-claude-status](https://github.com/long-910/vscode-claude-status) — 在 VS Code 状态栏显示 Claude Code 令牌使用量

---

## 贡献

开发环境搭建、构建说明及项目架构，请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。

---

## 许可证

[MIT](LICENSE) — © 2026 long-910
