import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ── Types mirroring the Rust JSON output ─────────────────────────────────────

interface PermInfo {
  read: boolean;
  write: boolean;
  execute: boolean;
}

interface SectionInfo {
  name: string;
  size: number;
  virtual_address: number;
  file_offset: number;
  entropy: number;
  permissions: PermInfo;
}

interface DangerousSymbol {
  name: string;
  category: string;
}

interface SecurityInfo {
  format: string;
  architecture: string;
  nx: string;
  pie: string;
  relro: string;
  canary: string;
  fortify: string;
  rpath: string;
  stripped: string;
  dangerous_symbols: DangerousSymbol[];
}

interface AnalysisOutput {
  file: string;
  sections: SectionInfo[];
  security: SecurityInfo;
  security_score: number;
  total_virtual_size: number;
  total_file_size: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Windows パス → WSL パスに変換する。
 * 例: "C:\Users\foo\bar"  →  "/mnt/c/Users/foo/bar"
 * 既に Unix スタイルのパスはそのまま返す。
 */
function toWslPath(winPath: string): string {
  const m = winPath.match(/^([a-zA-Z]):[/\\](.*)/s);
  if (m) {
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  }
  return winPath;
}

/**
 * ブリッジバイナリを探す。
 * バイナリは常に Linux ELF（.exe なし）。Windows でも同名で存在し wsl.exe 経由で実行する。
 */
function findBridgeBinary(extensionUri: vscode.Uri): string | undefined {
  const base = extensionUri.fsPath;
  const name = 'binsleuth-bridge';

  const candidates = [
    path.join(base, 'bin', name),
    path.join(base, 'src-rust', 'target', 'release', name),
    path.join(base, 'src-rust', 'target', 'debug', name),
  ];

  return candidates.find((p) => fs.existsSync(p));
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class BinsleuthViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'binsleuth.analysisView';

  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    // Handle messages sent from the webview
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'jumpToOffset') {
        await this._jumpToOffset(msg.file as string, msg.offset as number);
      } else if (msg.command === 'openFile') {
        await this._openFile(msg.file as string);
      } else if (msg.command === 'exportReport') {
        await this._exportReport(msg.format as string, msg.content as string, msg.defaultName as string);
      }
    });
  }

  // Public: called from extension.ts commands / auto-analysis
  public async analyzeFile(filePath: string): Promise<void> {
    if (!this._view) {
      // Panel not yet revealed — reveal it first
      await vscode.commands.executeCommand('binsleuth.analysisView.focus');
    }

    const bridge = findBridgeBinary(this._extensionUri);
    if (!bridge) {
      this._postError(
        'Bridge binary not found.\n\nRun: npm run build:rust',
      );
      return;
    }

    this._postStatus('analyzing', path.basename(filePath));

    // Windows ネイティブ VS Code では Rust ブリッジ（Linux ELF）を
    // wsl.exe 経由で実行し、パスも WSL 形式に変換して渡す。
    let cmd: string;
    let args: string[];
    if (process.platform === 'win32') {
      cmd = 'wsl.exe';
      args = [toWslPath(bridge), toWslPath(filePath)];
    } else {
      cmd = bridge;
      args = [filePath];
    }

    cp.execFile(
      cmd,
      args,
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          this._postError(`Analysis failed:\n${stderr || err.message}`);
          return;
        }
        try {
          const result: AnalysisOutput = JSON.parse(stdout);
          this._view?.webview.postMessage({ command: 'updateData', data: result });
        } catch {
          this._postError(`Failed to parse bridge output:\n${stdout.slice(0, 300)}`);
        }
      },
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _postStatus(status: 'analyzing' | 'idle', filename = ''): void {
    this._view?.webview.postMessage({ command: 'status', status, filename });
  }

  private _postError(message: string): void {
    this._view?.webview.postMessage({ command: 'error', message });
  }

  /** WSL パスから VS Code が開ける URI を構築する。 */
  private _fileUri(filePath: string): vscode.Uri {
    if (process.platform === 'win32') {
      // /mnt/c/... はそのまま Windows パスに戻して file:// にする
      const mnt = filePath.match(/^\/mnt\/([a-z])\/(.*)/s);
      if (mnt) {
        return vscode.Uri.file(`${mnt[1].toUpperCase()}:\\${mnt[2].replace(/\//g, '\\')}`);
      }
      // /home/... など WSL 内のパスは vscode-remote URI で開く
      return vscode.Uri.from({ scheme: 'vscode-remote', authority: 'wsl+Ubuntu', path: filePath });
    }
    return vscode.Uri.file(filePath);
  }

  private async _exportReport(format: string, content: string, defaultName: string): Promise<void> {
    const ext = format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'md';
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = base
      ? vscode.Uri.joinPath(base, defaultName)
      : vscode.Uri.file(defaultName);

    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        'Report': [ext],
        'All Files': ['*'],
      },
    });
    if (!saveUri) { return; }

    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf-8'));
    const openAction = 'Open';
    const choice = await vscode.window.showInformationMessage(
      `BinSleuth: Report saved — ${path.basename(saveUri.fsPath)}`,
      openAction,
    );
    if (choice === openAction) {
      await vscode.commands.executeCommand('vscode.open', saveUri);
    }
  }

  private async _openFile(filePath: string): Promise<void> {
    const uri = this._fileUri(filePath);
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'hexEditor.hexedit');
    } catch {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  private async _jumpToOffset(filePath: string, offset: number): Promise<void> {
    const uri = this._fileUri(filePath);
    const hexStr = `0x${offset.toString(16).toUpperCase().padStart(8, '0')}`;

    // Try to open with the Hex Editor extension if available
    try {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'hexEditor.hexedit',
      );
      // Give the hex editor time to open, then reveal
      setTimeout(async () => {
        try {
          await vscode.commands.executeCommand('hexEditor.revealLine', {
            uri: uri.toString(),
            startOffset: offset,
          });
        } catch {
          // revealLine not available — silently ignore
        }
      }, 300);
    } catch {
      // Hex editor not installed; open as regular file
      await vscode.commands.executeCommand('vscode.open', uri);
      vscode.window.showInformationMessage(
        `BinSleuth — Jump to offset ${hexStr} in ${path.basename(filePath)}`,
      );
    }
  }

  // ── HTML generation ─────────────────────────────────────────────────────────

  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = webview.cspSource;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src https://cdn.jsdelivr.net 'nonce-${nonce}';
             style-src 'unsafe-inline';
             img-src ${csp} data:;
             connect-src 'none';">
  <title>BinSleuth</title>
  <style>
    /* ── Reset & base ────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #080c14;
      --bg2:       #0d1420;
      --bg3:       #111c2b;
      --border:    #1a3a5c;
      --cyan:      #00d4ff;
      --green:     #00ff88;
      --red:       #ff1744;
      --orange:    #ff6b35;
      --purple:    #7b2fff;
      --gold:      #ffd700;
      --dim:       #4a6a8a;
      --text:      #c0d8f0;
      --text-dim:  #6888a8;
      --font:      'Courier New', 'Consolas', monospace;
    }

    html, body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      font-size: 11px;
      line-height: 1.4;
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* ── Scan-line animation ─────────────────────────────────────────── */
    #scan-overlay {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--cyan), transparent);
      box-shadow: 0 0 12px var(--cyan), 0 0 24px var(--cyan);
      animation: scan 2.5s linear infinite;
      pointer-events: none;
      z-index: 100;
      opacity: 0.7;
    }
    @keyframes scan {
      0%   { top: -2px; opacity: 1; }
      90%  { opacity: 0.7; }
      100% { top: 100vh; opacity: 0; }
    }

    /* ── Header ──────────────────────────────────────────────────────── */
    #header {
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--bg2);
      position: relative;
    }
    .logo-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .spacer { flex: 1; }
    .header-btn {
      display: none;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      background: transparent;
      border: 1px solid;
      border-radius: 3px;
      font-family: var(--font);
      font-size: 9px;
      letter-spacing: 1px;
      cursor: pointer;
      text-transform: uppercase;
      transition: background 0.15s, box-shadow 0.15s;
    }
    .header-btn.visible { display: flex; }
    #btn-open  { border-color: var(--cyan);  color: var(--cyan);  }
    #btn-open:hover  { background: rgba(0,212,255,0.12); box-shadow: 0 0 8px var(--cyan); }
    #btn-export { border-color: var(--green); color: var(--green); }
    #btn-export:hover { background: rgba(0,255,136,0.10); box-shadow: 0 0 8px var(--green); }

    /* Export dropdown */
    #export-wrapper { position: relative; }
    #export-menu {
      display: none;
      position: absolute;
      right: 0; top: calc(100% + 4px);
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 4px;
      min-width: 150px;
      z-index: 200;
      overflow: hidden;
      animation: fadeIn 0.15s ease;
    }
    #export-menu.open { display: block; }
    .export-item {
      padding: 6px 12px;
      font-size: 10px;
      cursor: pointer;
      color: var(--text);
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--border);
    }
    .export-item:last-child { border-bottom: none; }
    .export-item:hover { background: rgba(0,255,136,0.08); color: var(--green); }
    .logo-text {
      font-size: 13px;
      font-weight: bold;
      letter-spacing: 3px;
      color: var(--cyan);
      text-shadow: 0 0 8px var(--cyan);
    }
    .status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 6px var(--green);
      animation: pulse 2s ease-in-out infinite;
    }
    .status-dot.analyzing {
      background: var(--orange);
      box-shadow: 0 0 8px var(--orange);
      animation: blink 0.5s step-end infinite;
    }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0; } }

    #filename {
      font-size: 10px;
      color: var(--text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: 0.5px;
    }
    #score-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
    }
    #score-label {
      color: var(--text-dim);
      font-size: 10px;
      letter-spacing: 1px;
    }
    #score-bar-bg {
      flex: 1;
      height: 6px;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 3px;
      overflow: hidden;
    }
    #score-bar {
      height: 100%;
      width: 0%;
      border-radius: 3px;
      transition: width 1.2s cubic-bezier(0.4,0,0.2,1),
                  background 0.5s ease;
    }
    #score-val {
      font-size: 11px;
      font-weight: bold;
      min-width: 32px;
      text-align: right;
    }

    /* ── Panels ──────────────────────────────────────────────────────── */
    .panel {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
    }
    .panel-title {
      font-size: 9px;
      letter-spacing: 2px;
      color: var(--cyan);
      text-transform: uppercase;
      margin-bottom: 8px;
      text-shadow: 0 0 6px var(--cyan);
    }

    /* ── Security flags ──────────────────────────────────────────────── */
    #security-flags {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .flag-badge {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 3px;
      border: 1px solid;
      font-size: 9px;
      letter-spacing: 1px;
      text-transform: uppercase;
      transition: box-shadow 0.3s ease;
    }
    .flag-badge.enabled  { color: var(--green);  border-color: var(--green);  }
    .flag-badge.partial  { color: var(--orange); border-color: var(--orange); }
    .flag-badge.disabled { color: var(--red);    border-color: var(--red);    }
    .flag-badge.na       { color: var(--dim);    border-color: var(--dim);    }
    .flag-badge .dot { width:5px; height:5px; border-radius:50%; background:currentColor; }

    /* ── Binary info row ─────────────────────────────────────────────── */
    #binary-info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      font-size: 10px;
    }
    .info-item { display: flex; flex-direction: column; gap: 1px; }
    .info-key   { color: var(--text-dim); font-size: 9px; letter-spacing: 1px; }
    .info-val   { color: var(--text); }

    /* ── Dangerous symbols ───────────────────────────────────────────── */
    #dangerous-symbols-section { display: none; }
    #dangerous-list {
      max-height: 80px;
      overflow-y: auto;
      font-size: 9px;
      color: var(--orange);
    }
    #dangerous-list div { padding: 1px 0; }
    .sym-cat { color: var(--red); margin-right: 4px; }

    /* ── Sort select ─────────────────────────────────────────────────── */
    #combined-sort {
      margin-left: auto;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 3px;
      color: var(--cyan);
      font-family: var(--font);
      font-size: 9px;
      letter-spacing: 1px;
      padding: 2px 6px;
      cursor: pointer;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    #combined-sort:hover, #combined-sort:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 6px var(--cyan);
    }

    /* ── Chart containers ────────────────────────────────────────────── */
    .chart-wrap {
      position: relative;
      width: 100%;
    }
    .chart-wrap canvas { display: block; width: 100% !important; }

    /* ── Section legend ──────────────────────────────────────────────── */
    #section-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      cursor: pointer;
      padding: 2px 5px;
      border-radius: 2px;
      transition: background 0.2s;
    }
    .legend-item:hover { background: rgba(0,212,255,0.08); }
    .legend-dot {
      width: 8px; height: 8px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .legend-name { color: var(--text); }

    /* ── Section detail tooltip ──────────────────────────────────────── */
    #section-detail {
      margin-top: 8px;
      padding: 6px 8px;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-left: 2px solid var(--cyan);
      border-radius: 3px;
      font-size: 10px;
      display: none;
      animation: fadeIn 0.2s ease;
    }
    @keyframes fadeIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
    .detail-row { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
    .detail-key { color: var(--text-dim); }
    .detail-val { color: var(--cyan); text-align: right; }

    /* ── Empty / error states ────────────────────────────────────────── */
    #empty-state {
      padding: 32px 16px;
      text-align: center;
      color: var(--text-dim);
    }
    .empty-icon {
      font-size: 32px;
      margin-bottom: 12px;
      opacity: 0.4;
    }
    .empty-title {
      font-size: 11px;
      color: var(--cyan);
      letter-spacing: 2px;
      margin-bottom: 8px;
    }
    .empty-hint { font-size: 10px; line-height: 1.6; }

    #error-state {
      padding: 16px;
      color: var(--red);
      border: 1px solid var(--red);
      margin: 12px;
      border-radius: 4px;
      font-size: 10px;
      display: none;
      white-space: pre-wrap;
    }

    /* ── Scrollbar styling ───────────────────────────────────────────── */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--dim); }
  </style>
</head>
<body>

<div id="scan-overlay"></div>

<!-- ── Header ──────────────────────────────────────────────────────────────── -->
<div id="header">
  <div class="logo-row">
    <div class="status-dot" id="status-dot"></div>
    <span class="logo-text">BINSLEUTH</span>
    <div class="spacer"></div>
    <div id="export-wrapper">
      <button id="btn-export" class="header-btn" title="Export report">&#x2B07; EXPORT</button>
      <div id="export-menu">
        <div class="export-item" data-fmt="md">Markdown (.md)</div>
        <div class="export-item" data-fmt="json">JSON (.json)</div>
        <div class="export-item" data-fmt="csv">CSV (.csv)</div>
      </div>
    </div>
    <button id="btn-open" class="header-btn" title="Open file in editor">&#x25B6; OPEN</button>
  </div>
  <div id="filename">— NO FILE LOADED —</div>
  <div id="score-row">
    <span id="score-label">SCORE</span>
    <div id="score-bar-bg"><div id="score-bar"></div></div>
    <span id="score-val" style="color:var(--dim)">--</span>
  </div>
</div>

<!-- ── Empty / error states ────────────────────────────────────────────────── -->
<div id="empty-state">
  <div class="empty-icon">⬡</div>
  <div class="empty-title">AWAITING TARGET</div>
  <div class="empty-hint">
    Open an ELF / PE / binary file,<br>
    or right-click a file and choose<br>
    <strong style="color:var(--cyan)">BinSleuth: Analyze Binary</strong>
  </div>
</div>

<div id="error-state"></div>

<!-- ── Main content (hidden until data arrives) ─────────────────────────────── -->
<div id="main-content" style="display:none;">

  <!-- Security flags -->
  <div class="panel" id="security-panel">
    <div class="panel-title">Security Flags</div>
    <div id="security-flags"></div>
  </div>

  <!-- Binary info -->
  <div class="panel">
    <div class="panel-title">Binary Info</div>
    <div id="binary-info"></div>
  </div>

  <!-- Dangerous symbols (shown only if any exist) -->
  <div class="panel" id="dangerous-symbols-section">
    <div class="panel-title" style="color:var(--orange);text-shadow:0 0 6px var(--orange);">
      ⚠ Dangerous Symbols
    </div>
    <div id="dangerous-list"></div>
  </div>

  <!-- Section Map (Sunburst / Doughnut) -->
  <div class="panel">
    <div class="panel-title">Section Map</div>
    <div class="chart-wrap">
      <canvas id="sectionChart"></canvas>
    </div>
    <div id="section-legend"></div>
    <div id="section-detail"></div>
  </div>

  <!-- Section Heatmap (size = bar length, entropy = bar color) -->
  <div class="panel" style="border-bottom:none;">
    <div class="panel-title" style="display:flex;align-items:center;gap:6px;">
      Section Heatmap
      <select id="combined-sort" title="Sort order">
        <option value="offset">OFFSET ↑</option>
        <option value="size_desc">SIZE ↓</option>
        <option value="size_asc">SIZE ↑</option>
        <option value="entropy_desc">ENTROPY ↓</option>
        <option value="entropy_asc">ENTROPY ↑</option>
        <option value="name">NAME A-Z</option>
      </select>
    </div>
    <div class="chart-wrap">
      <canvas id="combinedChart"></canvas>
    </div>
  </div>

</div><!-- #main-content -->

<!-- Chart.js CDN -->
<script
  src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"
  nonce="${nonce}"
></script>

<script nonce="${nonce}">
(function () {
  'use strict';

  // ── VS Code API ────────────────────────────────────────────────────────────
  const vscode = acquireVsCodeApi();

  // ── Color helpers ──────────────────────────────────────────────────────────
  const SECTION_COLORS = {
    '.text':      '#00ff88',
    '.init':      '#00e07a',
    '.fini':      '#00c96d',
    '.plt':       '#ff6b35',
    '.plt.got':   '#ff8f60',
    '.plt.sec':   '#ff7a4a',
    '.data':      '#00d4ff',
    '.data.rel.ro': '#00b8e0',
    '.bss':       '#7b2fff',
    '.tbss':      '#8f40ff',
    '.tdata':     '#7060e0',
    '.rodata':    '#ffd700',
    '.got':       '#ffb830',
    '.got.plt':   '#ffa820',
    '.eh_frame':  '#36a2eb',
    '.eh_frame_hdr': '#4ab0f0',
    '.dynamic':   '#ff6384',
    '.interp':    '#4bc0c0',
    '.note':      '#4488aa',
    '.note.gnu':  '#3377aa',
    '.symtab':    '#9966ff',
    '.dynsym':    '#aa77ff',
    '.strtab':    '#8899bb',
    '.dynstr':    '#9aaabb',
    '.shstrtab':  '#778899',
    '.rela':      '#e8a030',
    '.rel':       '#d89020',
    '.debug':     '#555577',
    '.comment':   '#445566',
  };

  const PALETTE = [
    '#ff6384','#36a2eb','#ffce56','#4bc0c0','#9966ff',
    '#ff9f40','#c9cbcf','#7b2fff','#00d4ff','#00ff88',
    '#ff6b35','#ffd700','#e8a030','#4488aa','#9aaabb',
  ];

  function sectionColor(name, idx) {
    if (SECTION_COLORS[name]) return SECTION_COLORS[name];
    // strip version suffixes like .text.unlikely
    const base = name.replace(/\.\d+$/, '').split('.').slice(0, 3).join('.');
    if (SECTION_COLORS[base]) return SECTION_COLORS[base];
    return PALETTE[idx % PALETTE.length];
  }

  function entropyToColor(e) {
    const t = Math.min(1, Math.max(0, e / 8));
    let r, g, b;
    if (t < 0.375) {        // 0–3: dark-blue → cyan
      const s = t / 0.375;
      r = 0; g = Math.round(s * 180); b = 255;
    } else if (t < 0.625) { // 3–5: cyan → green
      const s = (t - 0.375) / 0.25;
      r = 0; g = Math.round(180 + s * 75); b = Math.round(255 - s * 255);
    } else if (t < 0.875) { // 5–7: green → orange
      const s = (t - 0.625) / 0.25;
      r = Math.round(s * 255); g = Math.round(255 - s * 80); b = 0;
    } else {                // 7–8: orange → red
      const s = (t - 0.875) / 0.125;
      r = 255; g = Math.round(175 - s * 175); b = 0;
    }
    return \`rgb(\${r},\${g},\${b})\`;
  }

  function scoreColor(score) {
    if (score >= 75) return '#00ff88';
    if (score >= 50) return '#ffd700';
    if (score >= 25) return '#ff6b35';
    return '#ff1744';
  }

  function flagClass(val) {
    if (!val) return 'na';
    const v = val.toLowerCase();
    if (v === 'enabled') return 'enabled';
    if (v.startsWith('partial')) return 'partial';
    if (v === 'disabled') return 'disabled';
    return 'na';
  }

  function fmtBytes(n) {
    if (n === 0) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function fmtHex(n) {
    return '0x' + n.toString(16).toUpperCase().padStart(8, '0');
  }

  // ── Chart instances ────────────────────────────────────────────────────────
  let sectionChart  = null;
  let combinedChart = null;
  let currentData   = null;

  // ── Chart.js global defaults (cyberpunk theme) ─────────────────────────────
  function initChartDefaults() {
    Chart.defaults.color = '#6888a8';
    Chart.defaults.font.family = "'Courier New', 'Consolas', monospace";
    Chart.defaults.font.size = 10;
    Chart.defaults.borderColor = '#1a3a5c';
  }

  // ── Section Map (Doughnut) ─────────────────────────────────────────────────
  function buildSectionChart(sections) {
    const ctx = document.getElementById('sectionChart').getContext('2d');

    // Sort by size descending for nicer visual
    const sorted = [...sections].sort((a, b) => b.size - a.size);
    // But include zero-size sections (.bss) with a minimum wedge so they're visible
    const MIN_DISPLAY = sorted.reduce((s, sec) => s + sec.size, 0) * 0.005;

    const labels = sorted.map(s => s.name);
    const sizes  = sorted.map(s => Math.max(s.size, MIN_DISPLAY));
    const colors = sorted.map((s, i) => sectionColor(s.name, i));
    const borderColors = colors.map(c => c + 'cc');

    if (sectionChart) { sectionChart.destroy(); }

    sectionChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: sizes,
          backgroundColor: colors.map(c => c + '99'),
          borderColor: borderColors,
          borderWidth: 1.5,
          hoverBackgroundColor: colors,
          hoverBorderColor: colors,
          hoverBorderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        cutout: '58%',
        animation: {
          animateRotate: true,
          animateScale: false,
          duration: 1200,
          easing: 'easeInOutQuart',
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0d1420ee',
            borderColor: '#1a3a5c',
            borderWidth: 1,
            titleColor: '#00d4ff',
            bodyColor: '#c0d8f0',
            padding: 10,
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => {
                const sec = sorted[item.dataIndex];
                return [
                  \`  Size    \${fmtBytes(sec.size)}\`,
                  \`  Offset  \${fmtHex(sec.file_offset)}\`,
                  \`  Entropy \${sec.entropy.toFixed(3)} bits\`,
                  \`  \${sec.permissions.execute ? 'X' : '-'}\${sec.permissions.write ? 'W' : '-'}\${sec.permissions.read ? 'R' : '-'}\`,
                ];
              },
            },
          },
        },
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const sec = sorted[elements[0].index];
          showSectionDetail(sec, colors[elements[0].index]);
          vscode.postMessage({
            command: 'jumpToOffset',
            file: currentData.file,
            offset: sec.file_offset,
          });
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
        },
      },
      plugins: [{
        // Centre text: total file size
        id: 'centreLabel',
        afterDraw(chart) {
          const { ctx, chartArea: { left, right, top, bottom } } = chart;
          const cx = (left + right) / 2;
          const cy = (top + bottom) / 2;

          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          ctx.font = 'bold 11px "Courier New", monospace';
          ctx.fillStyle = '#00d4ff';
          ctx.shadowColor = '#00d4ff';
          ctx.shadowBlur = 8;
          ctx.fillText(fmtBytes(currentData.total_file_size), cx, cy - 8);

          ctx.font = '9px "Courier New", monospace';
          ctx.fillStyle = '#6888a8';
          ctx.shadowBlur = 0;
          ctx.fillText(\`\${currentData.sections.length} SECTIONS\`, cx, cy + 7);
          ctx.restore();
        },
      }],
    });

    // Build legend
    const legend = document.getElementById('section-legend');
    legend.innerHTML = '';
    sorted.forEach((sec, i) => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.title = \`\${sec.name} — \${fmtBytes(sec.size)}\`;
      item.innerHTML = \`
        <div class="legend-dot" style="background:\${colors[i]};box-shadow:0 0 4px \${colors[i]}88;"></div>
        <span class="legend-name">\${sec.name}</span>
      \`;
      item.addEventListener('click', () => {
        showSectionDetail(sec, colors[i]);
        vscode.postMessage({ command: 'jumpToOffset', file: currentData.file, offset: sec.file_offset });
      });
      legend.appendChild(item);
    });
  }

  function showSectionDetail(sec, color) {
    const el = document.getElementById('section-detail');
    const perms = (sec.permissions.read ? 'R' : '-')
                + (sec.permissions.write ? 'W' : '-')
                + (sec.permissions.execute ? 'X' : '-');
    el.style.display = 'block';
    el.style.borderLeftColor = color;
    el.innerHTML = \`
      <div class="detail-row"><span class="detail-key">NAME</span><span class="detail-val" style="color:\${color}">\${sec.name}</span></div>
      <div class="detail-row"><span class="detail-key">SIZE</span><span class="detail-val">\${fmtBytes(sec.size)}</span></div>
      <div class="detail-row"><span class="detail-key">OFFSET</span><span class="detail-val">\${fmtHex(sec.file_offset)}</span></div>
      <div class="detail-row"><span class="detail-key">VADDR</span><span class="detail-val">\${fmtHex(sec.virtual_address)}</span></div>
      <div class="detail-row"><span class="detail-key">ENTROPY</span><span class="detail-val" style="color:\${entropyToColor(sec.entropy)}">\${sec.entropy.toFixed(3)} bits</span></div>
      <div class="detail-row"><span class="detail-key">PERMS</span><span class="detail-val">\${perms}</span></div>
    \`;
  }

  // ── Entropy Heatmap (horizontal bar chart) ─────────────────────────────────
  const SORT_FN = {
    offset:       (a, b) => a.file_offset - b.file_offset,
    size_desc:    (a, b) => b.size - a.size,
    size_asc:     (a, b) => a.size - b.size,
    entropy_desc: (a, b) => b.entropy - a.entropy,
    entropy_asc:  (a, b) => a.entropy - b.entropy,
    name:         (a, b) => a.name.localeCompare(b.name),
  };

  // ── Section Heatmap: bar length = size, bar color = entropy ───────────────
  function buildCombinedHeatmap(sections) {
    const canvas = document.getElementById('combinedChart');
    const ctx = canvas.getContext('2d');

    const sortKey = document.getElementById('combined-sort').value;
    const sorted  = [...sections].sort(SORT_FN[sortKey] ?? SORT_FN.offset);
    const maxSize = Math.max(...sorted.map(s => s.size), 1);

    const labels       = sorted.map(s => s.name);
    const sizes        = sorted.map(s => s.size);
    const bgColors     = sorted.map(s => entropyToColor(s.entropy) + 'bb');
    const borderColors = sorted.map(s => entropyToColor(s.entropy));

    const barHeight    = 24;
    const legendHeight = 32;
    const canvasHeight = Math.max(100, sorted.length * barHeight + 60 + legendHeight);
    canvas.style.height = canvasHeight + 'px';
    canvas.height = canvasHeight;

    if (combinedChart) { combinedChart.destroy(); }

    // Plugin: gradient entropy legend strip drawn above chart area
    const entropyLegendPlugin = {
      id: 'entropyLegend',
      afterDraw(chart) {
        const { ctx: c, chartArea } = chart;
        if (!chartArea) { return; }
        const { left, right, top } = chartArea;
        const stripY = top - legendHeight + 2;
        const stripH = 10;
        const w = right - left;

        const grad = c.createLinearGradient(left, 0, right, 0);
        grad.addColorStop(0,      entropyToColor(0));
        grad.addColorStop(0.3125, entropyToColor(2.5));
        grad.addColorStop(0.5,    entropyToColor(4));
        grad.addColorStop(0.6875, entropyToColor(5.5));
        grad.addColorStop(0.875,  entropyToColor(7));
        grad.addColorStop(1,      entropyToColor(8));

        c.save();
        c.fillStyle = grad;
        c.beginPath();
        if (c.roundRect) {
          c.roundRect(left, stripY, w, stripH, 3);
        } else {
          c.rect(left, stripY, w, stripH);
        }
        c.fill();

        // tick marks at 0, 2, 4, 6, 8
        [0, 2, 4, 6, 8].forEach(v => {
          const x = left + (v / 8) * w;
          c.fillStyle = 'rgba(0,0,0,0.5)';
          c.fillRect(x - 0.5, stripY, 1, stripH);
          c.fillStyle = '#6888a8';
          c.font = '8px Courier New';
          c.textAlign = 'center';
          c.textBaseline = 'top';
          c.fillText(String(v), x, stripY + stripH + 2);
        });

        c.fillStyle = '#4a6a8a';
        c.font = '7px Courier New';
        c.textAlign = 'right';
        c.textBaseline = 'top';
        c.fillText('entropy (bits)', right, stripY + stripH + 12);
        c.restore();
      },
    };

    // Plugin: entropy value labels on bars + neon glow for high-entropy
    const entropyLabelsPlugin = {
      id: 'entropyLabels',
      afterDatasetsDraw(chart) {
        const { ctx: c, chartArea } = chart;
        const meta = chart.getDatasetMeta(0);
        c.save();
        meta.data.forEach((bar, i) => {
          const sec    = sorted[i];
          const e      = sec.entropy;
          const props  = bar.getProps(['x', 'y', 'height'], true);
          const bx     = props.x;
          const by     = props.y;
          const bh     = props.height;
          const barW   = bx - chartArea.left;
          const glowC  = entropyToColor(e);

          // Neon glow overlay for entropy > 6.5
          if (e > 6.5) {
            c.save();
            c.shadowColor = glowC;
            c.shadowBlur  = 14;
            c.fillStyle   = glowC + '22';
            c.fillRect(chartArea.left, by - bh / 2, barW, bh);
            // second pass for extra glow
            c.shadowBlur = 8;
            c.fillStyle  = glowC + '11';
            c.fillRect(chartArea.left, by - bh / 2, barW, bh);
            c.restore();
          }

          // Entropy value label
          const label = e.toFixed(2);
          c.font = \`bold 9px 'Courier New', monospace\`;
          c.textBaseline = 'middle';
          const textW = c.measureText(label).width;
          if (barW > textW + 10) {
            c.fillStyle = 'rgba(0,0,0,0.75)';
            c.textAlign = 'right';
            c.fillText(label, bx - 5, by);
          } else {
            c.fillStyle = glowC;
            c.textAlign = 'left';
            c.fillText(label, bx + 5, by);
          }
        });
        c.restore();
      },
    };

    combinedChart = new Chart(ctx, {
      type: 'bar',
      plugins: [entropyLegendPlugin, entropyLabelsPlugin],
      data: {
        labels,
        datasets: [{
          label: 'Size',
          data: sizes,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1,
          borderRadius: 3,
          hoverBackgroundColor: borderColors,
          barThickness: barHeight - 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: legendHeight } },
        animation: {
          duration: 900,
          easing: 'easeOutQuart',
          delay: (actx) => actx.dataIndex * 40,
        },
        scales: {
          x: {
            min: 0,
            grid: { color: '#1a3a5c66' },
            ticks: {
              color: '#4a6a8a',
              callback: (v) => fmtBytes(v),
              maxTicksLimit: 6,
            },
            border: { color: '#1a3a5c' },
          },
          y: {
            grid: { display: false },
            ticks: { color: '#8899bb', font: { size: 9 } },
            border: { color: '#1a3a5c' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0d1420ee',
            borderColor: '#1a3a5c',
            borderWidth: 1,
            titleColor: '#00d4ff',
            bodyColor: '#c0d8f0',
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => {
                const sec = sorted[item.dataIndex];
                const pct = ((sec.size / maxSize) * 100).toFixed(1);
                const e   = sec.entropy;
                const risk = e > 7 ? ' ⚠ PACKED/ENCRYPTED' : e > 5.5 ? ' HIGH' : e > 3 ? ' NORMAL' : ' LOW';
                return [
                  \`  Size     \${fmtBytes(sec.size)} (\${pct}%)\`,
                  \`  Entropy  \${e.toFixed(3)} bits\${risk}\`,
                  \`  Offset   \${fmtHex(sec.file_offset)}\`,
                ];
              },
            },
          },
        },
        onClick: (evt, elements) => {
          if (!elements.length) { return; }
          const sec = sorted[elements[0].index];
          vscode.postMessage({
            command: 'jumpToOffset',
            file: currentData.file,
            offset: sec.file_offset,
          });
        },
        onHover: (evt, elements) => {
          evt.native.target.style.cursor = elements.length ? 'pointer' : 'default';
        },
      },
    });
  }

  // ── UI update helpers ──────────────────────────────────────────────────────
  function renderSecurityFlags(security) {
    const FLAGS = [
      { key: 'nx',      label: 'NX'     },
      { key: 'pie',     label: 'PIE'    },
      { key: 'relro',   label: 'RELRO'  },
      { key: 'canary',  label: 'CANARY' },
      { key: 'fortify', label: 'FORTIFY'},
      { key: 'stripped',label: 'STRIP'  },
    ];
    const container = document.getElementById('security-flags');
    container.innerHTML = FLAGS.map(({ key, label }) => {
      const val = security[key] || 'N/A';
      const cls = flagClass(val);
      const title = val.startsWith('Partial') ? val : '';
      return \`<div class="flag-badge \${cls}" title="\${title}">
        <div class="dot"></div>\${label}
      </div>\`;
    }).join('');
  }

  function renderBinaryInfo(data) {
    const el = document.getElementById('binary-info');
    const name = data.file.replace(/\\\\/g, '/').split('/').pop();
    el.innerHTML = \`
      <div class="info-item"><span class="info-key">FORMAT</span><span class="info-val">\${data.security.format}</span></div>
      <div class="info-item"><span class="info-key">ARCH</span><span class="info-val">\${data.security.architecture}</span></div>
      <div class="info-item"><span class="info-key">FILE SIZE</span><span class="info-val">\${fmtBytes(data.total_file_size)}</span></div>
      <div class="info-item"><span class="info-key">SECTIONS</span><span class="info-val">\${data.sections.length}</span></div>
    \`;
  }

  function renderDangerousSymbols(symbols) {
    const section = document.getElementById('dangerous-symbols-section');
    const list = document.getElementById('dangerous-list');
    if (!symbols || symbols.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    list.innerHTML = symbols.map(sym =>
      \`<div><span class="sym-cat">[\${sym.category}]</span>\${sym.name}</div>\`
    ).join('');
  }

  function renderScore(score) {
    const bar = document.getElementById('score-bar');
    const val = document.getElementById('score-val');
    const color = scoreColor(score);

    bar.style.width = score + '%';
    bar.style.background = \`linear-gradient(90deg, \${color}88, \${color})\`;
    bar.style.boxShadow = \`0 0 6px \${color}\`;
    val.textContent = score + '/100';
    val.style.color = color;
    val.style.textShadow = \`0 0 6px \${color}\`;
  }

  // ── Export ────────────────────────────────────────────────────────────────

  function generateMarkdown(data) {
    const h = data.security;
    const date = new Date().toISOString().slice(0, 10);
    const name = data.file.replace(/\\\\/g, '/').split('/').pop();
    const score = data.security_score;
    const bar = '█'.repeat(Math.round(score / 5)) + '░'.repeat(20 - Math.round(score / 5));
    const flagIcon = (v) => {
      const s = (v || '').toLowerCase();
      if (s === 'enabled') return '✅';
      if (s.startsWith('partial')) return '⚠️';
      if (s === 'disabled') return '❌';
      return '—';
    };

    const sections = [...data.sections].sort((a, b) => a.file_offset - b.file_offset);
    const sectionRows = sections.map((s, i) => {
      const perms = (s.permissions.read ? 'R' : '-')
                  + (s.permissions.write ? 'W' : '-')
                  + (s.permissions.execute ? 'X' : '-');
      return \`| \${String(i+1).padStart(2)} | \${s.name.padEnd(18)} | \${fmtBytes(s.size).padStart(9)} | \${fmtHex(s.file_offset)} | \${fmtHex(s.virtual_address)} | \${s.entropy.toFixed(3)} | \${perms} |\`;
    }).join('\\n');

    const dangerRows = h.dangerous_symbols.length
      ? h.dangerous_symbols.map(ds => \`- \\\`\${ds.name}\\\` (\${ds.category})\`).join('\\n')
      : '_None detected._';

    return \`# BinSleuth Analysis Report

| | |
|---|---|
| **File** | \\\`\${name}\\\` |
| **Path** | \\\`\${data.file}\\\` |
| **Format** | \${h.format} |
| **Architecture** | \${h.architecture} |
| **File Size** | \${fmtBytes(data.total_file_size)} |
| **Sections** | \${data.sections.length} |
| **Analyzed** | \${date} |

## Security Score

\\\`\${bar}\\\` **\${score} / 100**

## Security Flags

| Flag | Status |
|------|--------|
| NX (Non-executable stack) | \${flagIcon(h.nx)} \${h.nx} |
| PIE (Position-independent) | \${flagIcon(h.pie)} \${h.pie} |
| RELRO | \${flagIcon(h.relro)} \${h.relro} |
| Stack Canary | \${flagIcon(h.canary)} \${h.canary} |
| FORTIFY_SOURCE | \${flagIcon(h.fortify)} \${h.fortify} |
| Debug Stripped | \${flagIcon(h.stripped)} \${h.stripped} |
| RPATH | \${flagIcon(h.rpath)} \${h.rpath} |

## Sections

| # | Name | Size | File Offset | Virt. Addr | Entropy | Perms |
|---|------|-----:|-------------|------------|--------:|-------|
\${sectionRows}

## Dangerous Symbols

\${dangerRows}

---
_Generated by [BinSleuth](https://github.com/long-910/vscode-binsleuth)_
\`;
  }

  function generateCsv(data) {
    const header = 'name,size,virtual_address,file_offset,entropy,read,write,execute';
    const rows = [...data.sections]
      .sort((a, b) => a.file_offset - b.file_offset)
      .map(s => [
        \`"\${s.name}"\`,
        s.size,
        s.virtual_address,
        s.file_offset,
        s.entropy,
        s.permissions.read,
        s.permissions.write,
        s.permissions.execute,
      ].join(','));
    return [header, ...rows].join('\\n');
  }

  function generateReport(data, fmt) {
    if (fmt === 'json') { return JSON.stringify(data, null, 2); }
    if (fmt === 'csv')  { return generateCsv(data); }
    return generateMarkdown(data);
  }

  // Export button toggle
  const btnExport   = document.getElementById('btn-export');
  const exportMenu  = document.getElementById('export-menu');

  btnExport.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.classList.toggle('open');
  });
  document.addEventListener('click', () => exportMenu.classList.remove('open'));

  document.querySelectorAll('.export-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!currentData) { return; }
      const fmt  = item.dataset.fmt;
      const ext  = fmt === 'json' ? 'json' : fmt === 'csv' ? 'csv' : 'md';
      const base = currentData.file.replace(/\\\\/g, '/').split('/').pop().replace(/\\.[^.]+$/, '') || 'report';
      vscode.postMessage({
        command: 'exportReport',
        format:      fmt,
        content:     generateReport(currentData, fmt),
        defaultName: \`binsleuth-\${base}.\${ext}\`,
      });
      exportMenu.classList.remove('open');
    });
  });

  // ── Sort selector ──────────────────────────────────────────────────────────
  document.getElementById('combined-sort').addEventListener('change', () => {
    if (currentData) { buildCombinedHeatmap(currentData.sections); }
  });

  // ── Open button ────────────────────────────────────────────────────────────
  document.getElementById('btn-open').addEventListener('click', () => {
    if (currentData) {
      vscode.postMessage({ command: 'openFile', file: currentData.file });
    }
  });

  // ── Main data handler ──────────────────────────────────────────────────────
  function handleData(data) {
    currentData = data;

    // Show main content, hide empty/error states
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('error-state').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';

    // Show action buttons now that we have a file
    document.getElementById('btn-open').classList.add('visible');
    document.getElementById('btn-export').classList.add('visible');

    // Header
    const name = data.file.replace(/\\\\/g, '/').split('/').pop();
    document.getElementById('filename').textContent = name;

    // Score
    renderScore(data.security_score);

    // Status dot back to idle
    const dot = document.getElementById('status-dot');
    dot.classList.remove('analyzing');

    // Panels
    renderBinaryInfo(data);
    renderSecurityFlags(data.security);
    renderDangerousSymbols(data.security.dangerous_symbols);

    // Charts (slight delay so DOM is ready)
    setTimeout(() => {
      buildSectionChart(data.sections);
      buildCombinedHeatmap(data.sections);
    }, 50);
  }

  // ── Message listener ───────────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.command) {
      case 'updateData':
        handleData(msg.data);
        break;

      case 'status':
        if (msg.status === 'analyzing') {
          const dot = document.getElementById('status-dot');
          dot.classList.add('analyzing');
          document.getElementById('filename').textContent =
            \`ANALYZING: \${msg.filename}\`;
        }
        break;

      case 'error':
        document.getElementById('empty-state').style.display = 'none';
        document.getElementById('main-content').style.display = 'none';
        const errEl = document.getElementById('error-state');
        errEl.style.display = 'block';
        errEl.textContent = '⚠ ' + msg.message;
        document.getElementById('status-dot').classList.remove('analyzing');
        break;
    }
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  initChartDefaults();

})();
</script>

</body>
</html>`;
  }
}
