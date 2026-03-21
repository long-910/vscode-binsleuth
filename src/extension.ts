import * as path from 'path';
import * as vscode from 'vscode';
import { BinsleuthViewProvider } from './panel';

const BINARY_EXTS = new Set([
  '.elf', '.exe', '.dll', '.so', '.bin', '.o', '.a', '.dylib', '.out',
]);

/**
 * URI → ローカルファイルパスに変換する。
 *
 * Remote WSL 環境では uri.fsPath が "/Ubuntu/home/..." のように
 * ディストロ名をプレフィックスとして付加することがある。
 * uri.path は常にリモート側の正規パス ("/home/...") を返すため、
 * vscode-remote スキームの場合は uri.path を優先する。
 */
function toLocalPath(uri: vscode.Uri): string {
  return uri.scheme === 'vscode-remote' ? uri.path : uri.fsPath;
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
          vscode.window.showErrorMessage('BinSleuth: No file selected.');
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
          vscode.window.showErrorMessage('BinSleuth: No active file.');
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
