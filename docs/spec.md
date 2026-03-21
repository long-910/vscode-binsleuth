# Project Specification: vscode-binsleuth (Visualizer)

## 1. プロジェクト構成
本プロジェクトは、公開ライブラリ `binsleuth` を利用した「解析用ブリッジ（Rust）」と「VS Code拡張（TS）」の2層構造とする。

## 2. 技術スタック
- **Analysis Bridge (Rust):** - Dependency: `binsleuth` (crates.io), `serde`, `serde_json`, `goblin`
    - Role: `binsleuth` の解析結果を VS Code 拡張が扱いやすい JSON 形式に変換して出力する。
- **Extension (TypeScript):**
    - Role: Rustブリッジを実行し、Webview (Chart.js) で可視化。

## 3. 実装詳細

### 3.1 Backend: Analysis Bridge (Rust側)
`binsleuth` クレートを呼び出し、以下のデータを JSON で標準出力する単機能 CLI を作成する。
1. **Section Data**:
   - `binsleuth` で取得した各セクションの `name`, `size`, `address` を抽出。
   - 追加で `goblin` を使い、各セクションの `offset`（ファイル内位置）と `entropy`（シャノン係数）を計算。
2. **Security Status**:
   - `binsleuth` の既存機能（あれば）または `goblin` を使い、NX, PIE, Canary 等の有効フラグを判定。
3. **JSON Output**:
   - 構造体 `AnalysisResult` を定義し、`serde_json::to_string` で出力。

### 3.2 Frontend: VS Code Extension (TS側)
1. **Webview サイドバー**:
   - `Chart.js` (CDN利用) を使用し、サイドバーに **「サイバーパンク/SF風」** のUIを描画。
   - 主な可視化要素：
     - **セクションマップ (Sunburst Chart)**: バイナリ全体のサイズ構成を円形で表現。中心が全体、外側に向かって各セクションの比率を面積で表示。
     - **エントロピー分布 (Heatmap)**: 棒グラフの代わりに、各セクションをファイルオフセット順に並べ、エントロピーの高さを色温度（青→赤）で表現。
2. **Interaction**:
   - グラフのセクションをクリックすると、`vscode.hexeditor`（または標準エディタ）で該当 `offset` を開く。
   - コマンド: `vscode.commands.executeCommand('vscode.open', ...)`
3. **ライフサイクル管理**:
   - `onDidChangeActiveTextEditor` を監視し、`.bin`, `.elf`, `.exe` 等が開かれたら自動で解析ブリッジを走らせる。

## 4. 有意義なUXと「かっこよさ」の追求
- **サイバーパンクUI**:
  - VS Code のテーマ変数（`--vscode-editor-foreground` など）を積極的に活用しつつ、ネオンカラー（蛍光グリーン、サイアンブルー、警告用レッド）をアクセントに使用。
  - チャートのボーダーやフォントにSF風のスタイリングを適用。
- **アニメーション**: グラフ描画時やデータ更新時に、サイバーパンク風の滑らかなフェードイン/アウトアニメーションを実装。
- **埋め込み開発への配慮**: `.bss` のようにファイルサイズが 0 でもメモリ占有があるセクションを可視化に含める。
- **VS Code テーマ同期**: グラフの色調をエディタのテーマ（Dark/Light）に自動適応させる。

## 5. 実装ステップ
1. [Rust] `binsleuth` を依存関係に含めた CLI プロジェクトの作成。
2. [Rust] セクション情報の抽出とエントロピー計算、JSON出力の実装。
3. [TS] VS Code 拡張プロジェクトの初期化とサイドバー登録。
4. [TS] `child_process` による Rust バイナリの呼び出し。
5. [UI] **Chart.js** による「サンバースト図」と「エントロピーヒートマップ」の描画とクリックイベントの実装。
