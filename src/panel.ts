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
    #btn-open {
      display: none;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      background: transparent;
      border: 1px solid var(--cyan);
      border-radius: 3px;
      color: var(--cyan);
      font-family: var(--font);
      font-size: 9px;
      letter-spacing: 1px;
      cursor: pointer;
      text-transform: uppercase;
      transition: background 0.15s, box-shadow 0.15s;
    }
    #btn-open:hover {
      background: rgba(0,212,255,0.12);
      box-shadow: 0 0 8px var(--cyan);
    }
    #btn-open.visible { display: flex; }
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
    #entropy-sort {
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
    #entropy-sort:hover, #entropy-sort:focus {
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
    <button id="btn-open" title="Open file in editor">&#x25B6; OPEN</button>
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

  <!-- Entropy Heatmap -->
  <div class="panel" style="border-bottom:none;">
    <div class="panel-title" style="display:flex;align-items:center;gap:6px;">
      Entropy Heatmap
      <select id="entropy-sort" title="Sort order">
        <option value="offset">OFFSET ↑</option>
        <option value="size_desc">SIZE ↓</option>
        <option value="size_asc">SIZE ↑</option>
        <option value="entropy_desc">ENTROPY ↓</option>
        <option value="entropy_asc">ENTROPY ↑</option>
        <option value="name">NAME A-Z</option>
      </select>
    </div>
    <div class="chart-wrap">
      <canvas id="entropyChart"></canvas>
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
  let sectionChart = null;
  let entropyChart = null;
  let currentData = null;

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

  function buildEntropyChart(sections) {
    const ctx = document.getElementById('entropyChart').getContext('2d');

    const sortKey = document.getElementById('entropy-sort').value;
    const sorted = [...sections].sort(SORT_FN[sortKey] ?? SORT_FN.offset);
    const labels = sorted.map(s => s.name);
    const entropies = sorted.map(s => s.entropy);
    const bgColors = entropies.map(e => entropyToColor(e) + 'cc');
    const borderColors = entropies.map(e => entropyToColor(e));

    const barHeight = 22;
    const canvasHeight = Math.max(80, sorted.length * barHeight + 40);
    document.getElementById('entropyChart').style.height = canvasHeight + 'px';
    document.getElementById('entropyChart').height = canvasHeight;

    if (entropyChart) { entropyChart.destroy(); }

    entropyChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Entropy',
          data: entropies,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1,
          borderRadius: 2,
          hoverBackgroundColor: borderColors,
          barThickness: barHeight - 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 900,
          easing: 'easeOutQuart',
          delay: (ctx) => ctx.dataIndex * 40,
        },
        scales: {
          x: {
            min: 0,
            max: 8,
            grid: {
              color: '#1a3a5c66',
              tickLength: 4,
            },
            ticks: {
              color: '#4a6a8a',
              stepSize: 1,
              callback: (v) => v === 0 ? '0' : v === 8 ? '8 ▶' : String(v),
            },
            border: { color: '#1a3a5c' },
          },
          y: {
            grid: { display: false },
            ticks: {
              color: '#8899bb',
              font: { size: 9 },
            },
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
                const e = sec.entropy;
                const risk = e > 7 ? ' ⚠ PACKED/ENCRYPTED' : e > 5.5 ? ' high' : e > 3 ? ' normal' : ' low';
                return [
                  \`  Entropy  \${e.toFixed(3)}\${risk}\`,
                  \`  Offset   \${fmtHex(sec.file_offset)}\`,
                  \`  Size     \${fmtBytes(sec.size)}\`,
                ];
              },
            },
          },
          // Entropy scale legend (gradient bar)
          annotation: undefined,
        },
        onClick: (evt, elements) => {
          if (!elements.length) return;
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

  // ── Entropy sort selector ──────────────────────────────────────────────────
  document.getElementById('entropy-sort').addEventListener('change', () => {
    if (currentData) { buildEntropyChart(currentData.sections); }
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

    // Show Open button now that we have a file
    document.getElementById('btn-open').classList.add('visible');

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
      buildEntropyChart(data.sections);
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
