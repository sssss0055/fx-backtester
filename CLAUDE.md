# FX 過去検証トレーナー — Claude Code 作業ガイド

## プロジェクト概要

FXトレードの学習用過去検証(バックテスト)ツール。2つのモードを持つ:

1. **手動検証**: チャートを1本ずつ進めながら裁量トレードの練習をする
2. **自動検証**: ストラテジーを選択・パラメータ設定し、全データに対して自動でバックテストを実行する

現在はビルド不要のバニラJS構成(index.htmlを開くだけで動作)。
将来的にWebアプリ / モバイルアプリ化を予定(下記ロードマップ参照)。

## 実行方法

```bash
# 方法1: そのままブラウザで開く
open index.html

# 方法2: ローカルサーバー(推奨)
npx serve .
```

テストフレームワークやビルドステップは現時点では存在しない。
エンジンのロジック確認は Node で可能(下記「動作確認」参照)。

## アーキテクチャ

```
index.html          … UI構造(手動/自動の2ビュー、タブ切替)
css/style.css       … ダークテーマ(CSS変数でトークン管理)
js/
  data.js           … FX.data       価格データ生成(シード付き乱数で再現可能)
  strategies.js     … FX.strategies 売買戦略の定義(配列)
  engine.js         … FX.engine     バックテストエンジン・インジケーター・統計
  chart.js          … FX.chart      Canvasチャート描画(ローソク足/マーカー/損益カーブ)
  app.js            … UI制御(即時実行。M=手動モード / A=自動モード)
```

- モジュールは `window.FX` 名前空間のIIFEで実装(`file://` で動作させるため。ESM化はPhase 3)
- 依存関係: data / strategies / engine / chart は互いに独立。app.js が全てを結線
- 読み込み順は index.html の `<script>` の順序に依存(app.js が最後)

## 重要な設計ルール

### 戦略の追加方法
`js/strategies.js` の配列にオブジェクトを追加するだけでUIに自動反映される:

```js
{
  id: 'my_strategy',
  name: '表示名',
  desc: '説明文',
  warmup: 100,                    // シグナル計算に必要な最小バー数
  params: [{ key, label, def, min, max, step }],  // UIが自動生成される
  signal(ctx, i, p, pos) {        // 'buy'|'sell'|'close'|null を返す
    // ctx.sma(period,i) / ctx.rsi(period,i) / ctx.highest(p,i) / ctx.lowest(p,i)
    // ctx.candles[i] = {o,h,l,c}
  }
}
```

新しいインジケーターが必要な場合は `engine.js` の `createContext` に
キャッシュ付き配列計算(`memo`)として追加する。

### 約定モデル(変更時は要注意)
- シグナル判定は確定足の終値、同値で約定
- SL/TPは次足以降の高値/安値で判定。**同一足でSL/TP両到達時はSL優先(保守的)**
- スプレッドはエントリー時に不利方向へ加算
- 損益計算: 1万通貨あたり1pips = 100円(簡易モデル)。初期資金100万円

### コーディング規約
- UIテキストは日本語
- 数値表示は等幅フォント(`--mono`)、色はCSS変数(`--up`/`--down`等)を使用
- カラーコード直書きは chart.js の `C` オブジェクトと CSS変数に限定
- `file://` で動く状態を維持する(fetch必須の機能はPhase 2以降で)

## 動作確認

```bash
# 構文チェック
for f in js/*.js; do node --check "$f"; done

# エンジンの動作確認(ブラウザ不要)
node -e "
global.window = global;
require('./js/data.js'); require('./js/strategies.js'); require('./js/engine.js');
const ds = FX.data.generate(12345, 1500);
const r = FX.engine.run(ds.candles, ds.pair, FX.strategies[0], {fast:10, slow:50},
  {lot:1, slPips:30, tpPips:60, spreadPips:0.3});
console.log('trades:', r.trades.length, 'stats:', r.stats);
"
```

## ロードマップ

### Phase 1(完了): 自動検証の基盤
- [x] モジュール分割(data / strategies / engine / chart / app)
- [x] 自動バックテストエンジン(SL/TP/スプレッド/ドテン対応)
- [x] 戦略3種(MAクロス / RSI逆張り / ドンチャンブレイクアウト)
- [x] 成績統計(勝率 / PF / RR / 期待値 / 最大DD)+ 売買マーカー表示
- [x] シード指定によるデータ再現

### Phase 2: 実データ・分析強化(次にやること)
- [ ] CSVインポート(MT4/MT5・ヒストリカルデータ形式)→ `data.js` に loader 追加
- [ ] インジケーター追加(EMA / ボリンジャーバンド / MACD / ATR)
- [ ] ATRベースのSL/TP、トレーリングストップ
- [ ] パラメータ最適化(グリッドサーチ + 結果ヒートマップ)
- [ ] 検証結果のlocalStorage保存・比較 / CSVエクスポート
- [ ] 複数時間足の表示

### Phase 3: Webアプリ化
- [ ] Vite + TypeScript + React へ移行(engine/strategies はロジックそのまま移植)
- [ ] チャートライブラリ検討(lightweight-charts 等)or 自前Canvas継続
- [ ] テスト導入(Vitest でエンジンの単体テスト)
- [ ] PWA対応(オフライン動作・ホーム画面追加)

### Phase 4: アプリ・サービス化
- [ ] Capacitor でiOS/Androidアプリ化
- [ ] アカウント・クラウド同期(検証履歴の永続化)
- [ ] リアルタイムデータAPI連携

## 既知の制限
- 価格データは合成データ(実データ未対応 → Phase 2)
- 約定は終値ベースの簡易モデル(スリッページ未考慮)
- 損益の円換算は簡易計算(クロス円以外も1pips=100円/万通貨で近似)
