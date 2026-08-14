======================================================================
 RYU3 アプリ 改良版 (2026-08-14)
 空港手荷物処理能力シミュレーション
======================================================================

■ アプリについて
Next.js (App Router) + React 19 + TypeScript + Tailwind CSS で構築した、
空港手荷物処理能力シミュレーション。

**改良点：**
- 要件入力・編集画面を新設
- トップページを要件編集画面に変更
- localStorage で設定を保持
- シミュレーション画面へ自動反映

======================================================================
 このセッションでの変更点 (2026-08-14)
======================================================================

1. シミュレーション速度オプションを拡張
   - 速度バーの選択肢を 1〜100× から 1〜1000× まで拡張
   - 該当ファイル: components/baggage-simulation.tsx

2. 【バグ修正】「搭載終了」ボタンと通常再生で結果が食い違う問題を修正
   - 原因①: 「搭載終了」（一括計算, runToCompletion）は固定 dt=2.0秒/ステップ、
     通常再生はフレーム時間×速度倍率という別ロジックの dt を使っており、
     ベルト移動・作業者とのすれ違い判定・緊急停止しきい値判定の粒度が
     モードによって変わってしまっていた。
     → step() を「常に 0.1秒刻み（SIM_SUBSTEP）に内部でサブステップ分割してから
        処理する」実装に変更し、外から渡す dt の粗さに依存しないようにした。
   - 原因②: 拾い上げ確率・床置き確率・投入口選択に無シードの Math.random() を
     直接使っており、実行するたびに結果が変わっていた。
     → シード固定の擬似乱数（mulberry32, SIM_RNG_SEED）に置き換え、
        同じシナリオなら常に同じ結果になるようにした。
   - 検証: 「搭載終了」一括計算と、速度1000×での通常再生（自動完了まで）を
     比較し、緊急停止回数・投入済数が完全一致することをヘッドレスブラウザで確認済み。

3. 作業者上限を 100人 に変更（直近のコミットで対応済み、コード上は反映済み）

4. Vercel への本番デプロイを実施
   - 公開URL: https://ryu3.vercel.app
   - 誰でも（ログイン不要）アクセス可能
   - デプロイ方法: `ryu3` ディレクトリで `npx vercel --prod`
   - Supabase環境変数は未設定のままデプロイ（要件入力・シミュレーション画面は
     Supabase無しで動作する作りのため問題なし。認証機能のみ未設定で使用不可）

======================================================================
 ファイル構成
======================================================================

ryu3/
├── app/
│   ├── globals.css
│   ├── layout.tsx
│   ├── page.tsx                          ← 要件入力画面に変更
│   ├── auth/
│   │   ├── confirm/route.ts
│   │   ├── error/page.tsx
│   │   ├── forgot-password/page.tsx
│   │   ├── login/page.tsx
│   │   ├── sign-up/page.tsx
│   │   ├── sign-up-success/page.tsx
│   │   └── update-password/page.tsx
│   ├── protected/
│   │   ├── layout.tsx
│   │   └── page.tsx
│   └── simulation/
│       └── page.tsx                       ← シミュレーション画面
├── components/
│   ├── requirements-editor.tsx             ← 新規：要件入力画面
│   ├── baggage-simulation.tsx              ← 改良：設定読み込み機能追加
│   ├── auth-button.tsx
│   ├── deploy-button.tsx
│   ├── env-var-warning.tsx
│   ├── forgot-password-form.tsx
│   ├── hero.tsx
│   ├── login-form.tsx
│   ├── logout-button.tsx
│   ├── next-logo.tsx
│   ├── sign-up-form.tsx
│   ├── supabase-logo.tsx
│   ├── theme-switcher.tsx
│   ├── update-password-form.tsx
│   ├── tutorial/
│   │   ├── code-block.tsx
│   │   ├── connect-supabase-steps.tsx
│   │   ├── fetch-data-steps.tsx
│   │   ├── sign-up-user-steps.tsx
│   │   └── tutorial-step.tsx
│   └── ui/
│       ├── badge.tsx
│       ├── button.tsx
│       ├── card.tsx
│       ├── checkbox.tsx
│       ├── dropdown-menu.tsx
│       ├── input.tsx
│       └── label.tsx
├── lib/
│   ├── utils.ts
│   └── supabase/
│       ├── client.ts
│       ├── proxy.ts
│       └── server.ts
├── .env.example
├── .gitignore
├── components.json
├── eslint.config.mjs
├── next.config.ts
├── package.json
├── postcss.config.mjs
├── proxy.ts
├── tailwind.config.ts
└── tsconfig.json

======================================================================
 主要ファイル内容
======================================================================

■ アプリケーション入口
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ファイル: app/page.tsx
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import RequirementsEditor from '@/components/requirements-editor';

export default function Home() {
  return <RequirementsEditor />;
}

【説明】
トップページをRequirementsEditor（要件入力画面）に変更。
従来のBaggageSimulationはシミュレーション専用ページに移動。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 要件入力・編集画面（新規作成）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ファイル: components/requirements-editor.tsx
機能:
  - シナリオ名、空港名、稼働時間帯の入力
  - 投入量（時間当たり件数）の指定
  - 作業者人数の設定
  - ベルト寸法・速度の入力
  - 回転方向（時計/反時計）の切り替え
  - 設定を localStorage に保存
  - 編集内容をリアルタイム表示
  - シミュレーション画面へのリンク

エクスポート:
  - ScenarioConfig インターフェース
  - DEFAULT_SCENARIO_CONFIG 定数
  - SIM_CONFIG_STORAGE_KEY ストレージキー

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ シミュレーション画面（改良）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ファイル: components/baggage-simulation.tsx
ファイル: app/simulation/page.tsx

改良点:
  - localStorage から保存された設定を読み込み
  - 読み込んだ設定をシミュレーションの初期値に反映
  - 要件入力画面へのリンク

【フロー】
1. ユーザーが / にアクセス → 要件入力画面表示
2. 要件を入力して「保存」ボタンをクリック
3. localStorage に設定を保存
4. 「シミュレーションへ」ボタンをクリック → /simulation へ遷移
5. シミュレーション画面が保存された設定で初期化
6. シミュレーション実行

======================================================================
 ブラウザでのURL
======================================================================

ローカル開発:
- 要件入力画面: http://localhost:3000/
- シミュレーション: http://localhost:3000/simulation
- 認証: http://localhost:3000/auth/login

本番（実際に公開中）:
- https://ryu3.vercel.app/
- https://ryu3.vercel.app/simulation

======================================================================
 実行手順
======================================================================

1. 依存関係をインストール:
   $ npm install

2. 開発サーバー起動:
   $ npm run dev

3. ブラウザで http://localhost:3000 を開く

4. 要件入力画面で設定を入力し、保存

5. 「シミュレーションへ」で /simulation に遷移

6. シミュレーションを実行

======================================================================
 ビルド・デプロイ
======================================================================

本番ビルド:
$ npm run build

Vercel へのデプロイ（グローバルインストール済みの場合）:
$ vercel deploy

======================================================================
 設定の永続化
======================================================================

localStorage キー: 'ryu3-simulation-config'

保存内容（ScenarioConfig）:
- scenarioName: シナリオ名（文字列）
- airport: 空港名（文字列）
- operationHours: 稼働時間帯（文字列）
- totalBagsPerHour: 時間当たり投入量（数値）
- workerCount: 作業者人数（1-100）
- arrivalInterval: 投入間隔（秒/個）
- beltLongSide: 長辺（m）
- beltShortSide: 短辺（m）
- beltWidth: ベルト幅（m）
- bagLength: 荷物長さ（m）
- bagWidth: 荷物幅（m）
- beltSpeedMS: ベルト速度（m/s）
- floorDropProb: 床置き確率（0-1）
- pickupRate: ピックアップ率（0-1）
- workerTravelTime: 移動時間（秒）
- outerLaneCapacity: 外側レーン上限（個）
- innerLaneCapacity: 内側レーン上限（個）
- emergencyMargin: 緊急停止マージン（個）
- emergencyCollectInterval: 床置き追加時間（秒）
- clockwise: 回転方向（true=時計, false=反時計）
- notes: メモ（文字列）

======================================================================
 技術スタック
======================================================================

Framework:       Next.js 16.2.4
Runtime:         React 19.0.0
Language:        TypeScript 5
Styling:         Tailwind CSS 3.4.1
UI Components:   shadcn/ui
Authentication:  Supabase (設定済みだが現在未使用)
Package Manager: npm
Canvas Library:  (標準 CanvasAPI)

======================================================================
 利用可能なスクリプト
======================================================================

npm run dev       - 開発サーバー起動
npm run build     - 本番ビルド
npm run start     - 本番サーバー起動
npm run lint      - ESLint 実行

======================================================================
 今後の拡張候補
======================================================================

1. 複数シナリオの保存・読み込み
2. シナリオのエクスポート/インポート（CSV, JSON）
3. シミュレーション結果のグラフ表示
4. Supabase 認証の完全実装
5. シミュレーション結果の履歴管理
6. リアルタイムコラボレーション
7. モバイル対応の強化
8. ダークモード完全サポート

======================================================================
