import * as path from 'path';
import * as vscode from 'vscode';
import { BinsleuthViewProvider } from './panel';

const BINARY_EXTS = new Set([
  '.elf', '.exe', '.dll', '.so', '.bin', '.o', '.a', '.dylib', '.out',
]);

/**
 * URI → Linux (WSL) ブリッジが読めるファイルパスに変換する。
 *
 * ケース①: vscode-remote (WSL/SSH) URI
 *   uri.fsPath = "/Ubuntu/home/..."  ← ディストロ名プレフィックスが入る場合がある
 *   uri.path   = "/home/..."         ← 正規パス → こちらを使う
 *
 * ケース②: file:// URI でも WSL ディストロ名プレフィックスが付く場合
 *   fsPath = "/Ubuntu/home/..."  →  "/home/..."
 *   (VS Code が file:// スキームのまま /<distro>/... 形式を返すことがある)
 *
 * ケース③: WSL UNC パス (Windows ホスト側から見たパス)
 *   fsPath = "//wsl.localhost/Ubuntu/home/..."  →  "/home/..."
 *
 * ケース④: Windows ドライブレターパス (c:/... や C:\...)
 *   WSL では Windows ドライブは /mnt/<drive>/ にマウントされているため変換する
 *   例: "c:/Users/foo/bar"  →  "/mnt/c/Users/foo/bar"
 */
function toLocalPath(uri: vscode.Uri): string {
  // ケース①: vscode-remote スキームは uri.path が正規パス
  if (uri.scheme === 'vscode-remote') {
    return uri.path;
  }

  const p = uri.fsPath;

  // ケース④: Windows ドライブレター "C:\..." or "c:/..."  →  "/mnt/c/..."
  const winDrive = p.match(/^([a-zA-Z]):[/\\](.*)/s);
  if (winDrive) {
    const drive = winDrive[1].toLowerCase();
    const rest  = winDrive[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${rest}`;
  }

  // ケース③: WSL UNC "//wsl.localhost/Ubuntu/home/..."  →  "/home/..."
  const wslUnc = p.match(/^\/\/wsl[^/]*\/[^/]+(\/.*)/);
  if (wslUnc) {
    return wslUnc[1];
  }

  // ケース②: "/<DistroName>/<linux-root>/..."  →  "/<linux-root>/..."
  // 標準 Linux ルートディレクトリのいずれかで始まる第2コンポーネントを検出する
  const LINUX_ROOTS = /^\/(home|usr|opt|mnt|tmp|var|etc|bin|lib|run|srv|sys|proc|dev|root|boot)\b/;
  const distroPrefix = p.match(/^\/[^/]+(\/.*)/);
  if (distroPrefix && LINUX_ROOTS.test(distroPrefix[1])) {
    return distroPrefix[1];
  }

  return p;
}

/** URI を持つすべての Tab 種別から URI を取り出す */
function getTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) { return input.uri; }
  if (input instanceof vscode.TabInputCustom) { return input.uri; }
  return undefined;
}

/** アクティブなエディタ（テキスト / カスタム両方）の URI を返す */
function getActiveUri(): vscode.Uri | undefined {
  const textUri = vscode.window.activeTextEditor?.document.uri;
  if (textUri) { return textUri; }
  const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  return activeTab ? getTabUri(activeTab) : undefined;
}

function isBinaryUri(uri: vscode.Uri): boolean {
  return BINARY_EXTS.has(path.extname(toLocalPath(uri)).toLowerCase());
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new BinsleuthViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      BinsleuthViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // コマンド: エクスプローラー右クリック or URI 直接指定
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'binsleuth.analyzeFile',
      async (uri?: vscode.Uri) => {
        const target = uri ?? getActiveUri();
        if (!target) {
          vscode.window.showErrorMessage(vscode.l10n.t('BinSleuth: No file selected.'));
          return;
        }
        await provider.analyzeFile(toLocalPath(target));
      },
    ),
  );

  // コマンド: アクティブファイルを解析（テキスト / カスタムエディタ両対応）
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'binsleuth.analyzeActiveFile',
      async () => {
        const uri = getActiveUri();
        if (!uri) {
          vscode.window.showErrorMessage(vscode.l10n.t('BinSleuth: No active file.'));
          return;
        }
        await provider.analyzeFile(toLocalPath(uri));
      },
    ),
  );

  // 自動検出①: テキストエディタでバイナリが開かれた場合
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor && isBinaryUri(editor.document.uri)) {
        await provider.analyzeFile(toLocalPath(editor.document.uri));
      }
    }),
  );

  // 自動検出②: Hex Editor などカスタムエディタに切り替わった場合
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(({ changed }) => {
      for (const tab of changed) {
        if (!tab.isActive) { continue; }
        const uri = getTabUri(tab);
        if (uri && isBinaryUri(uri)) {
          provider.analyzeFile(toLocalPath(uri));
        }
      }
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}
