'use client';

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';

// ── Canvas dimensions ────────────────────────────────────────
const SW = 820;
const SH = 520;
const STATS_PANEL_W = 280;

// ── 公開URL（別PCから誰でもアクセスできる本番URL） ──────────────
const PUBLIC_SIMULATION_URL = 'https://ryu3.vercel.app/simulation';

// ── バージョン表示（タイトル右横の細字表示） ───────────────────
// ビルド時（next.config.tsでGitコミット日時から埋め込み）の値を「Ver. YYYY/MM/DD HH:mm」形式に整形する。
// 取得できない場合（ローカルでNEXT_PUBLIC_BUILD_COMMIT_TIMEが未設定など）は表示しない。
function formatBuildVersionLabel(): string | null {
  const iso = process.env.NEXT_PUBLIC_BUILD_COMMIT_TIME;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `Ver. ${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`;
}
const BUILD_VERSION_LABEL = formatBuildVersionLabel();

// ── Belt rectangle (defaults) ──────────────────────────────
const DEFAULT_LONG_SIDE = 38; // meters
const DEFAULT_SHORT_SIDE = 6.5; // meters
const PIXELS_PER_METER = 20;
const DEFAULT_BELT_WIDTH_M = 1.6; // meters
const BCX = 410, BCY = 230;
const WORKER_OFFSET = 45;
// ベルト中央に表示する「便数・作業者数」テキスト（太字40px）の概算半分の高さ(px, 等倍時)。
// 緊急停止ポップアップをこの上側に配置する際の被り判定に使う。
const BELT_CENTER_INFO_HALF_HEIGHT = 22;
// 緊急停止ポップアップ(DOM要素)の概算半分の高さ(px, 等倍時)
const EMERGENCY_POPUP_HALF_HEIGHT = 11;
// 緊急停止ポップアップと便数・作業者数テキストとの最低間隔(px, 等倍時)
const EMERGENCY_POPUP_GAP_Y = 3;
// ベルト内側の下寄りに横1行で表示する周回マーク凡例（△2周目・×3周目・☆4周目以上）の寸法(px, 等倍時)
const LAP_LEGEND_FONT_PX = 13;
const LAP_LEGEND_BOX_H = 24;
const BELT_INNER_MARGIN = 4; // ベルト内周と凡例との余白
const BELT_INNER_GAP_Y = 3; // 凡例と「便数・作業者数」テキストとの間隔

// ベルト内側の空きスペースの縦方向レイアウト（シーン座標）。
// 下から「周回マーク凡例」→（その上に）「便数・作業者数」テキスト→（さらに上に）緊急停止ポップアップ。
// テキストは凡例と被らないよう、必要な分だけベルト中央(BCY)より上へずらす。
// ポップアップはテキストの真上に置き、ベルト内周の上端からはみ出ないようにする（空きが足りなければテキストと重なることがある）。
function beltInnerLayout(beltW: number, beltH: number, beltWidthPx: number) {
  const beltR = Math.min(beltW, beltH) * 0.25;
  const innerHalfH = beltH / 2 - beltWidthPx / 2;
  const innerTop = BCY - innerHalfH;
  const innerBottom = BCY + innerHalfH;
  // 凡例の幅に使える長さ（内周の直線部分から余白を引いた分）
  const legendMaxW = Math.max(1, beltW - 2 * beltR - beltWidthPx - BELT_INNER_MARGIN * 2);
  // 内周の高さに収まらないときは凡例を縮小する（幅による縮小は描画時に文字幅を測って追加で行う）
  const legendScaleH = Math.min(1, Math.max(0.1, (innerHalfH * 2 - BELT_INNER_MARGIN * 2) / LAP_LEGEND_BOX_H));
  const legendH = LAP_LEGEND_BOX_H * legendScaleH;
  const legendCY = innerBottom - BELT_INNER_MARGIN - legendH / 2;
  const legendTop = legendCY - legendH / 2;
  const textY = Math.min(BCY, legendTop - BELT_INNER_GAP_Y - BELT_CENTER_INFO_HALF_HEIGHT);
  const clearOffsetY = BELT_CENTER_INFO_HALF_HEIGHT + EMERGENCY_POPUP_GAP_Y + EMERGENCY_POPUP_HALF_HEIGHT;
  const popupY = Math.min(textY - 20, Math.max(innerTop + EMERGENCY_POPUP_HALF_HEIGHT, textY - clearOffsetY));
  return { innerTop, innerBottom, legendCY, legendScaleH, legendMaxW, textY, popupY };
}
const WORKER_MIN_GAP_PX = 60; // 同じ辺に並ぶ作業者アイコン（直径約40px、発光エフェクト込みで見た目はもう少し大きい）同士の最低間隔(px, 等倍時)

// ── コンテナ（作業者外側の担当便コンテナ＋けん引車の列）の寸法 ────────────
// 描画（drawSim）と作業者配置（generateWorkerPositions の均等配置判定）で共通に使う
const CONTAINER_CAPACITY = 30; // コンテナ1基あたりの荷物数
const CONTAINER_MAX_SIZE = 14; // コンテナの基準サイズ（高さ・横方向の基準uの最大）
const CONTAINER_WIDTH_RATIO = 2; // コンテナの横幅＝u×2
const TUG_WIDTH_RATIO = 1.6; // けん引車の横幅＝u×1.6
const TOWBAR_RATIO = 0.4; // 連結棒の長さ＝u×0.4
const CONTAINER_GAP = 3; // コンテナ同士の間隔（基準サイズ時）
const TRAIN_MARGIN = 6; // 同じ列に並ぶ別の列（けん引車＋コンテナ）同士の最低間隔
// 基準サイズでコンテナk基を1列に並べたときの列の長さ（けん引車＋連結棒込み、px・等倍時）
function containerRowLengthPx(k: number): number {
  if (k <= 0) return 0;
  const u = CONTAINER_MAX_SIZE;
  return u * (TUG_WIDTH_RATIO + TOWBAR_RATIO) + k * u * CONTAINER_WIDTH_RATIO + (k - 1) * CONTAINER_GAP;
}

// ── 作業者人数 ────────────────────────────────────────────────
const DEFAULT_WORKER_COUNT = 4;
const MAX_WORKERS = 100;

// 作業者は「作業1」から順に、下辺→上辺→右辺→左辺の順番でラウンドロビンに配置する。
// （5人目は再び下辺、6人目は上辺…というように便数に応じて作業Noを増やしながら巡回する）
// t=0が上辺中央、t=0.25が右辺中央、t=0.5が下辺中央、t=0.75が左辺中央になる
// （beltInfoの円周パラメータ化の対称性により、ベルトの縦横比によらず常にこの位置になる）。
// 右辺・左辺はアイコンが密集しやすいため最大3名までとし、それを超える分は上辺・下辺
// （人数制限なし）に振り分ける。上辺・下辺が交互に埋まるので、なるべく均等に広がり
// アイコン同士が被りにくくなる。
const QUADRANT_FRAC = 0.25; // 隣り合う辺の中心同士は常にちょうど周長の1/4離れている（上記の対称性より）
const WORKER_EDGE_ORDER: { center: number; lengthKey: 'W_IN' | 'H_IN'; capacity: number }[] = [
  { center: 0.5,  lengthKey: 'W_IN', capacity: Infinity }, // 下辺（人数制限なし）
  { center: 0.0,  lengthKey: 'W_IN', capacity: Infinity }, // 上辺（人数制限なし）
  { center: 0.25, lengthKey: 'H_IN', capacity: 3 },        // 右辺（最大3名）
  { center: 0.75, lengthKey: 'H_IN', capacity: 3 },        // 左辺（最大3名）
];
// 作業者ごとの荷物数（担当便の予定投入数の合計）。generateWorkerPositions の辺の割り当て優先度に使う
function computeWorkerLoads(n: number, workerDests: number[][], destQuantities: number[]): number[] {
  return Array.from({ length: n }, (_, i) =>
    (workerDests[i] ?? []).reduce((sum, d) => sum + (destQuantities[d] ?? DEFAULT_DEST_QTY), 0));
}

// 作業者ごとのコンテナ基数（担当便ごとに「予定投入数÷30」を切り上げて合計。描画のコンテナ数と同じ数え方）
function computeWorkerContainerCounts(n: number, workerDests: number[][], destQuantities: number[]): number[] {
  return Array.from({ length: n }, (_, i) =>
    (workerDests[i] ?? []).reduce((sum, d) => sum + Math.ceil((destQuantities[d] ?? DEFAULT_DEST_QTY) / CONTAINER_CAPACITY), 0));
}

// 作業者の辺への割り当てと、辺の中の並べ方に必要な情報。シミュレーション状態（SimState.workerLayout）にも保存し、
// エクセル読み込み時に作業者の表示/非表示が切り替わったら、表示中の作業者だけでその辺を並べ直すのに使う。
// スナップショットで JSON 複製されるため、数値と配列のみで持つ（Infinity などは入れない）
interface WorkerEdgeLayout {
  edgeAssign: number[][]; // WORKER_EDGE_ORDER の辺ごとの作業者index（同じ辺の中は作業者番号順）
  edgeLenPx: number[]; // 辺ごとのまっすぐな部分の長さ(px)
  perimPx: number; // ベルト周長(px)
  containerCounts: number[] | null; // 作業者ごとのコンテナ基数（均等配置の判定用）
}

// loads（作業者ごとの荷物数）を渡すと、各辺の人数は下記の巡回で決めたまま、荷物数の多い作業者から
// 下辺→上辺→下辺→上辺…と交互に下辺・上辺へ置き、残りを右辺→左辺へ置く（同数は作業者番号の小さい方を優先）
function computeWorkerEdgeLayout(n: number, beltLongSideM: number, beltShortSideM: number, loads?: number[], containerCounts?: number[]): WorkerEdgeLayout {
  const BW = beltLongSideM * PIXELS_PER_METER;
  const BH = beltShortSideM * PIXELS_PER_METER;
  const BR = Math.min(BW, BH) * 0.25;
  const W_IN = BW - 2 * BR;
  const H_IN = BH - 2 * BR;
  const CORNER = (Math.PI / 2) * BR;
  const PERIM = 2 * W_IN + 2 * H_IN + 4 * CORNER;
  const edgeLength = { W_IN, H_IN };

  // 下辺→上辺→右辺→左辺の順に1人ずつ巡回して割り当てる。定員に達した辺は飛ばして次の辺に回す
  // （右辺・左辺が3名で埋まった後は、残りは自動的に上辺・下辺のみを交互に巡回する）。
  let edgeAssign: number[][] = WORKER_EDGE_ORDER.map(() => []);
  let edgeIdx = 0;
  for (let i = 0; i < n; i++) {
    for (let skip = 0; edgeAssign[edgeIdx % 4].length >= WORKER_EDGE_ORDER[edgeIdx % 4].capacity && skip < 4; skip++) {
      edgeIdx++;
    }
    edgeAssign[edgeIdx % 4].push(i);
    edgeIdx++;
  }

  // 荷物数の多い作業者を優先して下辺・上辺に置き、残りを右辺・左辺に置く（各辺の人数は上の巡回結果のまま）
  if (loads) {
    const counts = edgeAssign.map(a => a.length);
    const order = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => (loads[b] ?? 0) - (loads[a] ?? 0) || a - b);
    const next: number[][] = WORKER_EDGE_ORDER.map(() => []);
    let k = 0;
    // 下辺(0)・上辺(1)を交互に埋める（片方が定員に達したらもう片方へ）
    for (let j = 0; j < counts[0] + counts[1]; j++) {
      let e = j % 2;
      if (next[e].length >= counts[e]) e = 1 - e;
      next[e].push(order[k++]);
    }
    // 残りを右辺(2)→左辺(3)へ
    for (const e of [2, 3]) {
      for (let j = 0; j < counts[e]; j++) next[e].push(order[k++]);
    }
    // 同じ辺の中での並びは作業者番号順
    next.forEach(a => a.sort((x, y) => x - y));
    edgeAssign = next;
  }

  return {
    edgeAssign,
    edgeLenPx: WORKER_EDGE_ORDER.map(edge => edgeLength[edge.lengthKey]),
    perimPx: PERIM,
    containerCounts: containerCounts ?? null,
  };
}

// 辺 ei に idxs の作業者（作業者番号順）を並べ、positions[作業者index] に位置（周回パラメータ0〜1）を書き込む。
// containerCounts があれば、辺の全長を使って等間隔に並べても隣り合う作業者のコンテナ列（1列に並べた場合）
// 同士が重ならないときは、辺の全長を使って均等に配置する
function layoutWorkersOnEdge(layout: WorkerEdgeLayout, ei: number, idxs: number[], positions: number[]) {
  const edge = WORKER_EDGE_ORDER[ei];
  const PERIM = layout.perimPx;
  const edgeLenPx = layout.edgeLenPx[ei];
  const containerCounts = layout.containerCounts;
  const count = idxs.length;
  if (count === 0) return;
  const edgeLenFrac = edgeLenPx / PERIM;
  // コーナー付近を避けるため辺の中央80%を基本にしつつ、短い辺（右辺・左辺など）で
  // アイコン（直径約40px）同士が被ってしまう場合は、被らない最低限の間隔を確保できる
  // 幅まで広げる。t=0/0.25/0.5/0.75の対称性により、隣の辺の中心までは常にちょうど
  // 周長の1/4離れているため、そこへ食い込みすぎない範囲（1/4の約90%）を上限にする。
  const naturalSpanFrac = edgeLenFrac * 0.8;
  // 隣接アイコン間の間隔を WORKER_MIN_GAP_PX 以上にするための幅（隣接ギャップ = usableLenFrac/count * PERIM）
  const neededSpanFrac = count > 1 ? (WORKER_MIN_GAP_PX * count) / PERIM : 0;
  let usableLenFrac = Math.min(Math.max(naturalSpanFrac, neededSpanFrac), QUADRANT_FRAC * 1.8);
  // 人が少なくコンテナ同士が被らないときは、辺の全長を人数で等分した各区間の中央に置いて均等に配置する。
  // 判定: 全長配置での隣り合う作業者の間隔（辺の長さ÷人数）が、両者のコンテナ列の長さの半分ずつ＋最低間隔以上
  if (containerCounts && count > 1) {
    const pitchPx = edgeLenPx / count;
    const fits = idxs.every((wi, slot) => {
      if (slot === 0) return true;
      const prevLen = containerRowLengthPx(containerCounts[idxs[slot - 1]] ?? 0);
      const curLen = containerRowLengthPx(containerCounts[wi] ?? 0);
      if (prevLen === 0 || curLen === 0) return true;
      return pitchPx >= prevLen / 2 + curLen / 2 + TRAIN_MARGIN;
    });
    if (fits) usableLenFrac = edgeLenFrac;
  }
  idxs.forEach((workerIdx, slot) => {
    const frac = count === 1 ? 0.5 : (slot + 0.5) / count;
    const offset = (frac - 0.5) * usableLenFrac;
    positions[workerIdx] = ((edge.center + offset) % 1 + 1) % 1;
  });
}

// 全作業者の位置（リセット時の初期配置。全員を対象に各辺へ並べる）
function generateWorkerPositions(layout: WorkerEdgeLayout, n: number): number[] {
  const positions = new Array(n).fill(0);
  layout.edgeAssign.forEach((idxs, ei) => layoutWorkersOnEdge(layout, ei, idxs, positions));
  return positions;
}

// 作業者 workerIdx の担当辺を、表示中の作業者だけで並べ直す（非表示の作業者は位置をそのまま保つ）。
// エクセル読み込み時に作業者の表示/非表示が切り替わったときに step 内から呼ぶため、決定論性は保たれる
function relayoutVisibleWorkersOnEdge(s: SimState, workerIdx: number) {
  const layout = s.workerLayout;
  if (!layout) return;
  const ei = layout.edgeAssign.findIndex(idxs => idxs.includes(workerIdx));
  if (ei < 0) return;
  const visibleIdxs = layout.edgeAssign[ei].filter(i => s.workers[i]?.visible);
  const positions = s.workers.map(w => w.pos);
  layoutWorkersOnEdge(layout, ei, visibleIdxs, positions);
  for (const i of visibleIdxs) s.workers[i].pos = positions[i];
}

// ── Bag sizing (defaults) ───────────────────────────────────
const DEFAULT_BAG_L = 0.65; // meters
const DEFAULT_BAG_W = 0.43; // meters

// ── Injection points ─────────────────────────────────────────
const INJECT_POSITIONS = [0.25, 0.75];

// ── Destinations ─────────────────────────────────────────────
// エクセル読み込みルールでは便ごとに1つの行先枠を使うため、作業者上限と同数まで確保する
const NUM_DESTS = MAX_WORKERS;
// 荷物の色の種類（上限20色）。互いに見分けやすい20色（ダーク背景で暗すぎる色は明るめに調整）。
// 便への色は固定ではなく、便の荷物が初めてベルトに投入されたときに assignDestColor で動的に割り当てる。
const DEST_COLORS = [
  '#E6194B', '#3CB44B', '#FFE119', '#4363D8', '#F58231',
  '#A35BE0', '#42D4F4', '#F032E6', '#BFEF45', '#FABED4',
  '#2A9D8F', '#DCBEFF', '#B5793A', '#FFFAC8', '#AAFFC3',
  '#B8B82E', '#FFD8B1', '#7B8CFF', '#FFFFFF', '#B03A3A',
];
// 周回マーク（△・×・☆）を白で描く荷物の色（黒だと見づらい濃い色: エンジ・赤・青）。それ以外の色の荷物では黒で描く。
// 2周目以降の荷物は半透明でベルトの色と混ざるため、その状態でも黒のコントラストが低い色を選んでいる
const LAP_MARK_LIGHT_ON_BAG_COLORS = new Set(['#B03A3A', '#E6194B', '#4363D8']);
// 色が未割り当て（まだ荷物が投入されていない）便の表示色
const UNASSIGNED_DEST_COLOR = '#4B5563';
const DEST_NAMES = [
  'NH101', 'JL202', 'GK303', 'MM404', 'BC505',
  'LJ606', 'SFJ707', 'ADO808', 'SKY909', 'APJ010',
];
const DEFAULT_DEST_QTY = 200;
const DEFAULT_FLOOR_EXTRA_TIME = 4;
const DEFAULT_FLOOR_MAX = 10;

// ── 再現可能な乱数（シード固定）────────────────────────────────
// 「搭載終了」で一括計算した結果と、通常再生（速度1×〜1000×）で実行した結果が
// 実行のたびに/経路によって変わってしまわないよう、Math.random() の代わりに
// シード固定の擬似乱数を使う。同じシナリオなら常に同じ乱数列になる。
const SIM_RNG_SEED = 20260814;
// mulberry32 の内部状態を SimState.rngState（数値）に持たせ、呼ぶたびに進めて乱数を返す。
// 関数（クロージャ）ではなく数値で持つことで、タイムライン用スナップショット（JSON複製）にも
// 乱数の進み具合がそのまま保存され、スナップショットから再開しても乱数列が途切れない。
function nextRandom(s: { rngState: number }): number {
  const a = (s.rngState + 0x6D2B79F5) | 0;
  s.rngState = a;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
// 「ランダム」モード用: リセット（初期化）のたびに新しいシードを引く。
// 通常再生・搭載終了ともにこの値を使い回すことで、同じ回の中では常に一致した結果になる。
function drawRandomSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
}

// ── 荷物投入ルール ─────────────────────────────────────────────
// 新しい投入ルールを追加する場合は、この配列に1件追加するだけでよい。
// UIの切り替えバーは INJECTION_RULES を自動で読み取って選択肢を出す。
interface InjectionRuleContext {
  spawnedByDest: number[];
  destLimits: number[];
  time: number;
  rng: () => number;
}
interface InjectionRule {
  id: string;
  label: string;
  description: string;
  // 投入可能な行先(available)の中から、次に投入する1件を選んで返す
  pickDestination: (available: number[], ctx: InjectionRuleContext) => number;
  // このルールを選んだときだけ表示する追加UI(ファイルアップロード欄など)があればtrue
  needsFileUpload?: boolean;
}

const INJECTION_RULES: InjectionRule[] = [
  {
    id: 'uniform-random',
    label: '均等ランダム',
    description: '投入可能な行先の中からランダムに1つ選ぶ（現行ルール）',
    pickDestination: (available, ctx) => available[Math.floor(ctx.rng() * available.length)],
  },
  {
    id: 'excel-import',
    label: 'エクセル読み込み',
    description: '読み込んだエクセルの便名・時間帯別投入数に従って便ごとに作業者を自動配置し、時刻通りに投入する',
    needsFileUpload: true,
    // 実際の投入タイミング・行先は step() 内で s.flightEvents のスケジュールに従って直接処理される。
    // ファイル未読込み時のみ、このフォールバック（均等ランダム）が使われる。
    pickDestination: (available, ctx) => available[Math.floor(ctx.rng() * available.length)],
  },
  // ここに新しいルールを追加していく。例:
  // {
  //   id: 'round-robin',
  //   label: '順番割当',
  //   description: '投入可能な行先を順番に均等配分する',
  //   pickDestination: (available, ctx) => {
  //     const idx = ctx.spawnedByDest.reduce((a, b) => a + b, 0) % available.length;
  //     return available[idx];
  //   },
  // },
];

function getInjectionRule(id: string): InjectionRule {
  return INJECTION_RULES.find(r => r.id === id) ?? INJECTION_RULES[0];
}

// ── Scene layout: ベルト＋作業者＋グラフ（ベルト下）をキャンバス(SW×SH)に収める ──
// グラフはベルトの下に配置する。ベルトの長辺・短辺・幅や作業者配置がどんな値でも、
// シーン全体（ベルト＋作業者マージン＋寸法線＋グラフ）を一括で「今の枠」ぎりぎりに
// 縮小し、絶対にキャンバスからはみ出さないようにする（拡大はしない＝scaleは最大1）。
// SCENE_OUTER_MARGIN 分の余白を必ず残すことで、要素がキャンバスの枠線に触れて
// 被って見えることがないようにする。
const SCENE_MARGIN_SIDE = 100;        // ベルト左右の作業者・統計ボックス用マージン(px, 等倍時)
const SCENE_MARGIN_TOP = 100;         // ベルト上の作業者用マージン(px, 等倍時)
const SCENE_MARGIN_BOTTOM_BELT = 100; // ベルト下・寸法線より上の作業者用マージン(px, 等倍時)
const CHART_GAP = 16;                 // ベルト下マージンとグラフの間隔(px, 等倍時)。寸法線・テキストは
                                       // SCENE_MARGIN_BOTTOM_BELT内に収まっているので、被らない最小限の間隔でよい。
const CHART_NATURAL_W = 820;          // グラフの理想幅(px, 等倍時)
const SCENE_OUTER_MARGIN = 14;        // シーン全体とキャンバス枠線との間に必ず確保する余白(px, 等倍時)

interface SceneLayout {
  scale: number;
  tx: number; ty: number; // ctx.translate(tx,ty) の後に ctx.scale(scale,scale) して使う（ベルト＋周辺アイコン用。ベルト中心がキャンバス左右中央）
  chartTx: number; // グラフ用の横方向translate（シーン左端をキャンバス左枠ぎりぎりに寄せる従来位置）
  boxLeft: number; boxRight: number; boxTop: number; beltAreaBottom: number; // 等倍座標系でのクランプ用境界
  chart: { x: number; y: number; w: number; h: number };      // 等倍座標系でのグラフ矩形（canvas描画用）
  chartFinal: { x: number; y: number; w: number; h: number }; // 変換後の実キャンバス座標系でのグラフ矩形（DOMオーバーレイ配置用）
  beltCenterFinal: { x: number; y: number }; // 変換後の実キャンバス座標系でのベルト中央（DOMオーバーレイ配置用）
  emergencyPopupFinal: { x: number; y: number }; // 緊急停止ポップアップの表示位置（ベルト中央の便数・作業者数表示の真上、被らない位置）
}

function computeSceneLayout(beltW: number, beltH: number, beltWidthPx: number): SceneLayout {
  const groupW = Math.max(beltW + SCENE_MARGIN_SIDE * 2, CHART_NATURAL_W);
  const boxLeft = BCX - groupW / 2;
  const boxRight = BCX + groupW / 2;
  const boxTop = BCY - beltH / 2 - SCENE_MARGIN_TOP;
  const beltAreaBottom = BCY + beltH / 2 + SCENE_MARGIN_BOTTOM_BELT;
  // 左右位置はシーン枠の左端ぎりぎりに寄せる。縦位置・縦サイズは、ベルト下マージンのすぐ下から
  // ベルト＋作業者マージン全体と同じ高さ（beltAreaBottom - boxTop）まで拡張する＝上側のベルトと
  // 被らない範囲で最大限のサイズになる。ベルト形状が変わっても自動追従する。
  const chartX = boxLeft;
  const chartY = beltAreaBottom + CHART_GAP;
  const chartH = beltAreaBottom - boxTop;
  const boxBottom = chartY + chartH;
  const groupH = boxBottom - boxTop;

  // 枠線ぎりぎりに要素が触れないよう、キャンバスの実寸から余白を差し引いた領域に収める。
  // 横方向: グラフは左端をSCENE_OUTER_MARGINに固定する（chartTx。＝グラフが常に左枠ぎりぎりに寄る）。
  // ベルト＋周辺アイコンは、ベルト中心(BCX)がキャンバスの左右中央に来るよう別のtxで配置する
  // （シーンはBCXを軸に左右対称なので、中央寄せしてもキャンバス内に収まる）。縮小率は共通。
  // 縦方向は従来通り中央寄せのまま。
  const availW = SW - SCENE_OUTER_MARGIN * 2;
  const availH = SH - SCENE_OUTER_MARGIN * 2;
  const scale = Math.min(availW / groupW, availH / groupH, 1);
  const chartTx = SCENE_OUTER_MARGIN - boxLeft * scale;
  const tx = SW / 2 - BCX * scale;
  const ty = (SH - groupH * scale) / 2 - boxTop * scale;

  // 緊急停止ポップアップは、ベルト中央の「便数・作業者数」テキスト（周回マーク凡例の分だけ上へずらした位置）の真上、
  // ベルト内周からはみ出ない位置に配置する（beltInnerLayout）
  const { popupY } = beltInnerLayout(beltW, beltH, beltWidthPx);

  return {
    scale, tx, ty, chartTx,
    boxLeft, boxRight, boxTop, beltAreaBottom,
    chart: { x: chartX, y: chartY, w: CHART_NATURAL_W, h: chartH },
    chartFinal: {
      x: chartTx + chartX * scale,
      y: ty + chartY * scale,
      w: CHART_NATURAL_W * scale,
      h: chartH * scale,
    },
    beltCenterFinal: { x: tx + BCX * scale, y: ty + BCY * scale },
    emergencyPopupFinal: { x: tx + BCX * scale, y: ty + popupY * scale },
  };
}

// ── Types ────────────────────────────────────────────────────
interface FloorBag {
  id: number;
  color: string;
  timer: number;
  maxTimer: number;
  destination: number;
}

interface Bag {
  id: number;
  pos: number;
  color: string;
  destination: number;
  circuits: number;
  rejects: number;
  state: 'belt' | 'queued' | 'floor';
  workerId: number | null;
  lane: 0 | 1; // 0=内側, 1=外側
}

interface WorkerDef {
  id: number;
  pos: number;
  speed: number;
  queue: Bag[];
  current: Bag | null;
  procTimer: number;
  floorQueue: FloorBag[];
  activeFloor: FloorBag | null;
  floorBatchActive: boolean;
  floorDoneCount: number;
  doneCount: number;
  workloadPt: number;
  activeProcPt: number;
  assignedDests: number[];
  // 便（destination）ごとの搭載済み個数（直搭載＋床搭載）。コンテナの便別塗りつぶし表示に使う
  loadedByDest: Record<number, number>;
  emergencyCollectTimer: number;
  travelTimer: number;
  // 「エクセル読み込み」ルール用: 担当便の荷物が初めて投入されるまで非表示、
  // 担当便の荷物が全て投入されたら再び非表示にする。それ以外のルールでは常にtrue。
  visible: boolean;
}

interface HistPt {
  t: number;
  belt: number;
  floor: number;
  done: number;
  queues: number[];
  spawned: number;
  flights: number; // ベルト上にある荷物の行先便数（重複便名は1便として集計）
  // 便（destination）ごとの内訳スナップショット（グラフの「便フィルタ」で特定の便のみに絞り込んで
  // 再集計するために使う。サイズはいずれもNUM_DESTS）
  beltByDest: number[];
  spawnedByDest: number[];
  doneByDest: number[];
}

interface SimState {
  bags: Bag[];
  workers: WorkerDef[];
  time: number;
  nextSpawn: number;
  nextId: number;
  hist: HistPt[];
  totalDone: number;
  totalFloor: number;
  totalOverflow: number;
  lastHist: number;
  spawnedByDest: number[];
  firstOuterExceedTime: number | null;
  firstOverflowTime: number | null;
  completedTime: number | null;
  beltW: number; // in pixels
  beltH: number; // in pixels
  beltR: number; // in pixels
  beltPerim: number; // in pixels
  beltWidthPx: number; // in pixels
  bagW: number;  // in pixels (long side in meters -> pixels)
  bagH: number;  // in pixels (short side in meters -> pixels)
  emergencyStop: boolean;
  emergencyStopCount: number;
  emergencyStopTotalTime: number;
  // 「エクセル読み込み」ルール用: 便ごとの投入スケジュール（時刻順）と、次に処理すべき位置
  flightEvents: FlightSpawnEvent[] | null;
  flightEventIdx: number;
  // シード固定の擬似乱数（mulberry32）の内部状態。nextRandom(s) で乱数を取り出す
  // （再現性確保のため Math.random() の代わりに使う。数値なのでスナップショットにも保存される）
  rngState: number;
  // 便（destination）ごとの搭載開始時刻（初回投入時刻）・完了時刻（投入予定数分の処理・床仮置き・
  // オーバーフロー破棄がすべて完了した時刻）。「一番手荷物量が多かった便の搭載所要時間」表示に使う。
  destFirstSpawnTime: (number | null)[];
  destFinishedCount: number[];
  destCompletionTime: (number | null)[];
  // 便（destination）ごとの処理済み累計（通常処理完了＋床仮置き処理完了のみ。オーバーフロー破棄は含まない。
  // グローバル集計のtotalDoneと同じ数え方を便単位で保持する）。グラフの便フィルタ用。
  doneByDest: number[];
  // 便（destination）ごとに割り当てた荷物の色（未投入の便は null）。assignDestColor で割り当てる
  destColor: (string | null)[];
  // 作業者がベルトから取った荷物の累計を、取った時点の周回で分けた数 [1周目, 2周目, 3周目, 4周目以上]
  // （circuits=0/1/2/3以上。通常のピック〔待ち行列・床置き〕と緊急停止時の床置き回収を含む）
  pickByLap: [number, number, number, number];
  // 作業者の辺への割り当て・並べ方の情報（エクセル読み込み時に表示中の作業者だけで並べ直すのに使う）
  workerLayout: WorkerEdgeLayout | null;
}

// 荷物をベルトから取ったときに周回別ピック数を加算する
function recordPickByLap(s: SimState, bag: Bag) {
  // 古いスナップショット由来で要素が3つの場合も4つ目を0から数える
  const i = Math.min(bag.circuits, 3);
  s.pickByLap[i] = (s.pickByLap[i] ?? 0) + 1;
}

interface FlightSpawnEvent {
  time: number; // 秒（シミュレーション開始からの経過時間）
  dest: number; // 行先(destination index) = 便に割り当てられた作業者のindex
}

// ── Belt geometry calculations ──────────────────────────────
function getPerimeter(longSide: number, shortSide: number): number {
  const BW = longSide * PIXELS_PER_METER;
  const BH = shortSide * PIXELS_PER_METER;
  const BR = Math.min(BW, BH) * 0.25;
  const W_IN = BW - 2 * BR;
  const H_IN = BH - 2 * BR;
  const CORNER = (Math.PI / 2) * BR;
  return 2 * W_IN + 2 * H_IN + 4 * CORNER;
}

// ── Belt geometry ────────────────────────────────────────────
function beltInfo(t: number, s: SimState): { pt: [number, number]; normal: [number, number]; tangent: [number, number] } {
  const { beltW: BW, beltH: BH, beltR: BR, beltPerim: PERIM } = s;
  const W_IN = BW - 2 * BR;
  const H_IN = BH - 2 * BR;
  const CORNER = (Math.PI / 2) * BR;
  let d = (((t % 1) + 1) % 1) * PERIM;

  if (d < W_IN / 2) return { pt: [BCX + d, BCY - BH / 2], normal: [0, -1], tangent: [1, 0] };
  d -= W_IN / 2;
  if (d < CORNER) {
    const a = -Math.PI / 2 + (d / CORNER) * (Math.PI / 2);
    const c = Math.cos(a), s = Math.sin(a);
    return { pt: [BCX + W_IN / 2 + BR * c, BCY - H_IN / 2 + BR * s], normal: [c, s], tangent: [-s, c] };
  }
  d -= CORNER;
  if (d < H_IN) return { pt: [BCX + BW / 2, BCY - H_IN / 2 + d], normal: [1, 0], tangent: [0, 1] };
  d -= H_IN;
  if (d < CORNER) {
    const a = (d / CORNER) * (Math.PI / 2);
    const c = Math.cos(a), s = Math.sin(a);
    return { pt: [BCX + W_IN / 2 + BR * c, BCY + H_IN / 2 + BR * s], normal: [c, s], tangent: [-s, c] };
  }
  d -= CORNER;
  if (d < W_IN) return { pt: [BCX + W_IN / 2 - d, BCY + BH / 2], normal: [0, 1], tangent: [-1, 0] };
  d -= W_IN;
  if (d < CORNER) {
    const a = Math.PI / 2 + (d / CORNER) * (Math.PI / 2);
    const c = Math.cos(a), s = Math.sin(a);
    return { pt: [BCX - W_IN / 2 + BR * c, BCY + H_IN / 2 + BR * s], normal: [c, s], tangent: [-s, c] };
  }
  d -= CORNER;
  if (d < H_IN) return { pt: [BCX - BW / 2, BCY + H_IN / 2 - d], normal: [-1, 0], tangent: [0, -1] };
  d -= H_IN;
  if (d < CORNER) {
    const a = Math.PI + (d / CORNER) * (Math.PI / 2);
    const c = Math.cos(a), s = Math.sin(a);
    return { pt: [BCX - W_IN / 2 + BR * c, BCY - H_IN / 2 + BR * s], normal: [c, s], tangent: [-s, c] };
  }
  d -= CORNER;
  return { pt: [BCX - W_IN / 2 + d, BCY - BH / 2], normal: [0, -1], tangent: [1, 0] };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function workerXY(w: WorkerDef, s: SimState): [number, number] {
  const { pt: [bx, by], normal: [nx, ny] } = beltInfo(w.pos, s);
  return [bx + nx * WORKER_OFFSET, by + ny * WORKER_OFFSET];
}

// ── Simulation init ──────────────────────────────────────────
function makeState(
  workerPositions: number[],
  workerSpeeds: number[],
  assignedDests: number[][],
  beltLongSide: number,
  beltShortSide: number,
  bagLen: number,
  bagWidth: number,
  beltWidthM: number,
  flightEvents: FlightSpawnEvent[] | null = null,
  rngSeed: number = SIM_RNG_SEED,
  workerLayout: WorkerEdgeLayout | null = null,
): SimState {
  const beltW = beltLongSide * PIXELS_PER_METER;
  const beltH = beltShortSide * PIXELS_PER_METER;
  const beltR = Math.min(beltW, beltH) * 0.25;
  const beltPerim = getPerimeter(beltLongSide, beltShortSide);
  const beltWidthPx = beltWidthM * PIXELS_PER_METER;
  const bagW = bagLen * PIXELS_PER_METER;
  const bagH = bagWidth * PIXELS_PER_METER;

  // 便別スケジュールが有効なときは、担当便の荷物が最初に投入されるまで作業者を非表示にする
  const startHidden = !!flightEvents && flightEvents.length > 0;

  const workers: WorkerDef[] = workerPositions.map((pos, i) => ({
    id: i, pos, speed: 1 / workerSpeeds[i],
    queue: [], current: null, procTimer: 0,
    floorQueue: [], activeFloor: null, floorBatchActive: false, floorDoneCount: 0, doneCount: 0,
    workloadPt: 0, activeProcPt: 0,
    assignedDests: assignedDests[i] ?? [],
    loadedByDest: {},
    emergencyCollectTimer: 0, travelTimer: 0,
    visible: !startHidden,
  }));
  return {
    bags: [], workers, time: 0, nextSpawn: 0, nextId: 0, hist: [],
    totalDone: 0, totalFloor: 0, totalOverflow: 0, lastHist: 0,
    spawnedByDest: new Array(NUM_DESTS).fill(0),
    firstOuterExceedTime: null, firstOverflowTime: null, completedTime: null,
    beltW, beltH, beltR, beltPerim, beltWidthPx,
    bagW, bagH,
    emergencyStop: false,
    emergencyStopCount: 0,
    emergencyStopTotalTime: 0,
    flightEvents: flightEvents && flightEvents.length > 0 ? flightEvents : null,
    flightEventIdx: 0,
    rngState: rngSeed | 0,
    destFirstSpawnTime: new Array(NUM_DESTS).fill(null),
    destFinishedCount: new Array(NUM_DESTS).fill(0),
    destCompletionTime: new Array(NUM_DESTS).fill(null),
    doneByDest: new Array(NUM_DESTS).fill(0),
    destColor: new Array(NUM_DESTS).fill(null),
    pickByLap: [0, 0, 0, 0],
    workerLayout,
  };
}

// 便に荷物の色を割り当てる（割り当て済みならその色を返す）。便の荷物が初めてベルトに投入されたときに呼ぶ。
// 優先順: ①ベルト上になく、搭載未完了の他便も使っていない色 ②ベルト上にない色（使い終わった色の再利用）
// ③全色使用中なら、ベルト上の荷物が一番少ない色（同色の重複を許容）。乱数は使わないため決定論性は保たれる。
function assignDestColor(s: SimState, dest: number): string {
  const existing = s.destColor[dest];
  if (existing) return existing;
  const onBelt = new Map<string, number>();
  for (const b of s.bags) if (b.state === 'belt') onBelt.set(b.color, (onBelt.get(b.color) ?? 0) + 1);
  const held = new Set<string>();
  s.destColor.forEach((c, d) => {
    if (c && d !== dest && s.destCompletionTime[d] === null) held.add(c);
  });
  const color =
    DEST_COLORS.find(c => !onBelt.has(c) && !held.has(c)) ??
    DEST_COLORS.find(c => !onBelt.has(c)) ??
    DEST_COLORS.reduce((best, c) => ((onBelt.get(c) ?? 0) < (onBelt.get(best) ?? 0) ? c : best));
  s.destColor[dest] = color;
  return color;
}

// ベルト上の空きレーンをスキャンして荷物を1個配置する。配置できたらtrueを返す。
function placeBagOnBelt(s: SimState, dest: number, spawnPos: number, outerLaneCapacity: number): boolean {
  const bagFraction = s.bagW / s.beltPerim;
  const MAX_SCAN = 0.15;

  // 指定レーンをspawnPosから近傍MAX_SCAN範囲でスキャン
  const scanLane = (lane: 0 | 1): number | null => {
    let scanPos = spawnPos;
    let scanned = 0;
    while (scanned < MAX_SCAN) {
      const dist = (p: number) => { const v = Math.abs(p - scanPos); return Math.min(v, 1 - v); };
      if (!s.bags.some(b => b.state === 'belt' && b.lane === lane && dist(b.pos) < bagFraction)) {
        return scanPos;
      }
      scanPos = (scanPos + bagFraction * 0.9) % 1;
      scanned += bagFraction * 0.9;
    }
    return null;
  };

  // 指定レーンをベルト全周でスキャン（遠くても空きがあれば配置）
  const scanLaneFull = (lane: 0 | 1): number | null => {
    const stepSize = bagFraction * 0.4;
    let scanPos = 0;
    while (scanPos < 1) {
      const sp = scanPos;
      const dist = (p: number) => { const v = Math.abs(p - sp); return Math.min(v, 1 - v); };
      if (!s.bags.some(b => b.state === 'belt' && b.lane === lane && dist(b.pos) < bagFraction)) {
        return sp;
      }
      scanPos += stepSize;
    }
    return null;
  };

  // 外側レーンが上限に達していたら内側を優先、そうでなければ外側を優先
  const outerCount = s.bags.filter(b => b.state === 'belt' && b.lane === 1).length;
  const primaryLane: 0 | 1 = outerCount >= outerLaneCapacity ? 0 : 1;
  const fallbackLane: 0 | 1 = primaryLane === 1 ? 0 : 1;

  let actualPos: number | null = scanLane(primaryLane);
  let actualLane: 0 | 1 = primaryLane;

  if (actualPos === null) {
    // プライマリ近傍に空きなし → フォールバックレーン近傍を試みる
    actualPos = scanLane(fallbackLane);
    if (actualPos !== null) actualLane = fallbackLane;
  }

  if (actualPos === null) {
    // 近傍に空きなし → 両レーンをベルト全周でスキャン（容量上限チェックなし・物理空きのみ）
    for (const lane of [primaryLane, fallbackLane] as (0 | 1)[]) {
      const pos = scanLaneFull(lane);
      if (pos !== null) { actualPos = pos; actualLane = lane; break; }
    }
  }

  if (actualPos === null) return false;

  s.bags.push({
    id: s.nextId++, pos: actualPos, color: assignDestColor(s, dest), destination: dest,
    circuits: 0, rejects: 0, state: 'belt', workerId: null, lane: actualLane,
  });
  return true;
}

// 「エクセル読み込み」ルール用: 担当便の荷物が投入されるたびに呼び、
// 最初の1個で作業者を表示し、その便の投入数が上限に達したら再び非表示にする。
function markFlightBagFlow(s: SimState, dest: number, destLimits: number[]) {
  const count = s.spawnedByDest[dest];
  const worker = s.workers.find(w => w.assignedDests.includes(dest));
  if (!worker) return;
  const wasVisible = worker.visible;
  if (count === 1) worker.visible = true;
  if (destLimits[dest] > 0 && count >= destLimits[dest]) worker.visible = false;
  // 表示/非表示が切り替わったら、その作業者の担当辺を表示中の作業者だけで均等に並べ直す
  if (worker.visible !== wasVisible) relayoutVisibleWorkersOnEdge(s, worker.id);
}

// 便（destination）ごとの「搭載開始時刻」を記録する。その便の荷物が初めて投入された瞬間の時刻。
function recordDestSpawn(s: SimState, dest: number) {
  if (s.destFirstSpawnTime[dest] === null) s.destFirstSpawnTime[dest] = s.time;
}

// 便（destination）ごとの荷物が1個「片づいた」（通常処理完了／床仮置き処理完了／オーバーフロー破棄の
// いずれか）たびに呼ぶ。投入予定数(destLimits[dest])分すべて片づいた時刻を「搭載完了時刻」として記録する。
function markDestFinished(s: SimState, dest: number, destLimits: number[]) {
  s.destFinishedCount[dest]++;
  if (s.destCompletionTime[dest] === null && destLimits[dest] > 0 && s.destFinishedCount[dest] >= destLimits[dest]) {
    s.destCompletionTime[dest] = s.time;
  }
}

// 便フィルタ（「全便」以外）選択中に、対象便のみへ適用する処理速度の上書き設定。
interface SpeedOverride { dests: number[]; seconds: number }

// 荷物1個あたりの処理時間（秒）を返す。対象便（destination）が上書き設定に含まれていればその秒数、
// そうでなければ担当作業者の通常速度（1/w.speed）を使う。
function effectiveProcSeconds(w: WorkerDef, destination: number, speedOverride: SpeedOverride | null): number {
  if (speedOverride && speedOverride.dests.includes(destination)) return speedOverride.seconds;
  return 1 / w.speed;
}

// ── Simulation step ──────────────────────────────────────────
// 1回の内部更新（stepOnce）あたりの秒数。呼び出し側（通常再生・「搭載終了」一括計算の
// どちらも）が渡してくる dt がどんなに粗くても、この粒度に細分してから処理することで、
// ベルト移動・作業者とのすれ違い判定・緊急停止しきい値判定などが dt の大きさに左右されず
// 常に同じ経路をたどるようにする（＝速度やモードを変えても結果が一致するようにする）。
const SIM_SUBSTEP = 0.1;

function step(
  s: SimState,
  dt: number,
  arrivalInterval: number,
  beltSpeed: number,
  floorDropProb: number,
  destLimits: number[],
  pickupRate: number,
  pickupForceThreshold: number,
  outerLaneCapacity: number,
  innerLaneCapacity: number,
  floorExtraTime: number,
  floorMax: number,
  floorBatchThreshold: number,
  beltFloorTrigger: number,
  workerTravelTime: number,
  emergencyMargin: number,
  emergencyCollectInterval: number,
  clockwise: boolean,
  injectionRuleId: string,
  speedOverride: SpeedOverride | null = null,
) {
  let remaining = dt;
  while (remaining > 1e-9) {
    const sub = Math.min(SIM_SUBSTEP, remaining);
    stepOnce(
      s, sub, arrivalInterval, beltSpeed, floorDropProb, destLimits,
      pickupRate, pickupForceThreshold, outerLaneCapacity, innerLaneCapacity,
      floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger,
      workerTravelTime, emergencyMargin, emergencyCollectInterval, clockwise, injectionRuleId,
      speedOverride,
    );
    remaining -= sub;
  }
}

function stepOnce(
  s: SimState,
  dt: number,
  arrivalInterval: number,
  beltSpeed: number,
  floorDropProb: number,
  destLimits: number[],
  pickupRate: number,
  pickupForceThreshold: number,
  outerLaneCapacity: number,
  innerLaneCapacity: number,
  floorExtraTime: number,
  floorMax: number,
  floorBatchThreshold: number,
  beltFloorTrigger: number,
  workerTravelTime: number,
  emergencyMargin: number,
  emergencyCollectInterval: number,
  clockwise: boolean,
  injectionRuleId: string,
  speedOverride: SpeedOverride | null = null,
) {
  s.time += dt;

  // ベルト半充填チェック（毎ステップ確認）
  if (s.firstOuterExceedTime === null) {
    const beltCount = s.bags.filter(b => b.state === 'belt').length;
    if (beltCount >= (outerLaneCapacity + innerLaneCapacity) / 2) s.firstOuterExceedTime = s.time;
  }

  // Emergency stop: trigger when belt count reaches overflow threshold - margin
  const beltBagCount = s.bags.filter(b => b.state === 'belt').length;
  const emergencyThreshold = outerLaneCapacity + innerLaneCapacity - emergencyMargin;

  if (!s.emergencyStop && beltBagCount >= emergencyThreshold) {
    s.emergencyStop = true;
    s.emergencyStopCount++;
  }

  if (s.emergencyStop) {
    s.emergencyStopTotalTime += dt;
    // Resume when inner lane is empty AND all floor queues are cleared
    const innerLaneBeltCount = s.bags.filter(b => b.state === 'belt' && b.lane === 0).length;
    const allFloorCleared = s.workers.every(w => w.floorQueue.length === 0 && !w.activeFloor);
    if (innerLaneBeltCount === 0 && allFloorCleared) {
      s.emergencyStop = false;
      s.nextSpawn = s.time;
      s.workers.forEach(w => { w.emergencyCollectTimer = 0; });
    } else {
      // Each worker gradually collects inner lane belt bags to floor (1 bag per 1/w.speed seconds)
      for (const w of s.workers) {
        const innerRemaining = s.bags.filter(b => b.state === 'belt' && b.lane === 0).length;
        if (innerRemaining === 0) break;

        const targetBag = s.bags.find(b => b.state === 'belt' && b.lane === 0 && w.assignedDests.includes(b.destination));
        if (!targetBag) continue;

        w.emergencyCollectTimer += dt;
        const interval = emergencyCollectInterval > 0 ? emergencyCollectInterval : 0.001;
        if (w.emergencyCollectTimer >= interval) {
          w.emergencyCollectTimer -= interval;
          recordPickByLap(s, targetBag);
          targetBag.state = 'floor';
          targetBag.workerId = w.id;
          const ft = effectiveProcSeconds(w, targetBag.destination, speedOverride) + floorExtraTime;
          w.floorQueue.push({ id: targetBag.id, color: targetBag.color, timer: ft, maxTimer: ft, destination: targetBag.destination });
          s.totalFloor++;
        }
      }
      s.bags = s.bags.filter(b => b.state !== 'floor');
    }
  }

  // Spawn bags respecting per-destination limits AND assignment
  const assignedSet = new Set<number>();
  s.workers.forEach(w => w.assignedDests.forEach(d => assignedSet.add(d)));

  if (!s.emergencyStop) {
    if (injectionRuleId === 'excel-import' && s.flightEvents) {
      // ── 便別スケジュール投入（エクセル読み込みルール） ──────────────
      // 各便の投入時刻はファイル読み込み時に事前計算済み。時刻が来た順に1個ずつ投入する。
      while (s.flightEventIdx < s.flightEvents.length && s.time >= s.flightEvents[s.flightEventIdx].time) {
        const dest = s.flightEvents[s.flightEventIdx].dest;
        const totalBeltCount = s.bags.filter(b => b.state === 'belt').length;

        if (totalBeltCount >= outerLaneCapacity + innerLaneCapacity) {
          // ベルト満杯 → オーバーフローとして扱い、この便の投入完了判定は進める
          if (s.firstOverflowTime === null) s.firstOverflowTime = s.time;
          s.totalOverflow++;
          s.nextId++;
          s.spawnedByDest[dest]++;
          recordDestSpawn(s, dest);
          markDestFinished(s, dest, destLimits);
          markFlightBagFlow(s, dest, destLimits);
          s.flightEventIdx++;
          continue;
        }

        // 2つの投入口からランダムに投入する
        const spawnPos = INJECT_POSITIONS[nextRandom(s) < 0.5 ? 0 : 1];
        if (!placeBagOnBelt(s, dest, spawnPos, outerLaneCapacity)) {
          // 物理的な空きがない → 次のステップで同じ荷物を再試行する
          break;
        }
        s.spawnedByDest[dest]++;
        recordDestSpawn(s, dest);
        markFlightBagFlow(s, dest, destLimits);
        s.flightEventIdx++;
      }
    } else {
      // ── 既存: 到着間隔ベースの投入（均等ランダム 等） ──────────────
      const totalLimit = destLimits.reduce((a, b, i) => assignedSet.has(i) ? a + b : a, 0);
      const totalSpawned = s.spawnedByDest.reduce((a, b, i) => assignedSet.has(i) ? a + b : a, 0);
      if (totalSpawned < totalLimit) {
        while (s.time >= s.nextSpawn) {
          const available = Array.from({ length: NUM_DESTS }, (_, i) => i)
            .filter(d => assignedSet.has(d) && s.spawnedByDest[d] < destLimits[d]);
          if (available.length > 0) {
            const spawnPos = INJECT_POSITIONS[s.nextId % INJECT_POSITIONS.length];
            const dest = getInjectionRule(injectionRuleId).pickDestination(available, {
              spawnedByDest: s.spawnedByDest,
              destLimits,
              time: s.time,
              rng: () => nextRandom(s),
            });
            s.spawnedByDest[dest]++;
            recordDestSpawn(s, dest);

            // 外側レーン上限+内側レーン上限の合計を超えたらオーバーフローとしてカウント
            const totalBeltCount = s.bags.filter(b => b.state === 'belt').length;
            if (totalBeltCount >= outerLaneCapacity + innerLaneCapacity) {
              if (s.firstOverflowTime === null) s.firstOverflowTime = s.time;
              s.totalOverflow++;
              s.nextId++;
              markDestFinished(s, dest, destLimits);
              s.nextSpawn += arrivalInterval * (0.6 + nextRandom(s) * 0.8);
              continue;
            }

            if (!placeBagOnBelt(s, dest, spawnPos, outerLaneCapacity)) {
              // 両レーン全周で空きなし → 先行インクリメントを戻して再試行
              s.spawnedByDest[dest]--;
              s.nextSpawn += arrivalInterval * (0.6 + nextRandom(s) * 0.8);
              continue;
            }
          }
          s.nextSpawn += arrivalInterval * (0.6 + nextRandom(s) * 0.8);
        }
      }
    }
  }

  for (const bag of s.bags) {
    if (bag.state !== 'belt') continue;
    if (s.emergencyStop) continue;
    const prevPos = bag.pos;
    if (clockwise) {
      bag.pos += beltSpeed * dt;
      if (bag.pos >= 1.0) { bag.pos -= 1.0; bag.circuits++; }
    } else {
      bag.pos -= beltSpeed * dt;
      if (bag.pos < 0) { bag.pos += 1.0; bag.circuits++; }
    }

    for (const w of s.workers) {
      const wPos = w.pos;
      let crossed = false;
      if (clockwise) {
        if (prevPos <= bag.pos) { crossed = prevPos <= wPos && wPos < bag.pos; }
        else { crossed = wPos >= prevPos || wPos < bag.pos; }
      } else {
        if (prevPos >= bag.pos) { crossed = bag.pos < wPos && wPos <= prevPos; }
        else { crossed = wPos <= prevPos || wPos > bag.pos; }
      }
      if (!crossed) continue;

      const isAssigned = w.assignedDests.includes(bag.destination);
      if (!isAssigned) continue;

      if (w.current !== null || w.queue.length > 0) continue;

      const effectivePickupRate = beltBagCount <= pickupForceThreshold ? 1.0 : pickupRate;
      if (nextRandom(s) >= effectivePickupRate) continue;

      const forceFloor = beltBagCount >= beltFloorTrigger;
      recordPickByLap(s, bag);
      if (w.floorQueue.length + (w.activeFloor ? 1 : 0) < floorMax && (forceFloor || nextRandom(s) < floorDropProb)) {
        bag.state = 'floor'; bag.workerId = w.id;
        const ft = effectiveProcSeconds(w, bag.destination, speedOverride) + floorExtraTime;
        w.floorQueue.push({ id: bag.id, color: bag.color, timer: ft, maxTimer: ft, destination: bag.destination });
        s.totalFloor++; break;
      } else {
        bag.state = 'queued'; bag.workerId = w.id; bag.pos = w.pos; w.queue.push(bag); break;
      }
    }

  }
  s.bags = s.bags.filter(b => b.state !== 'floor');

  const beltCountNow = s.bags.filter(b => b.state === 'belt').length;
  const beltSparse = beltCountNow <= (outerLaneCapacity + innerLaneCapacity) / 2;

  for (const w of s.workers) {
    // 排他処理: 通常処理中は床仮置き処理不可、床仮置き処理中は通常処理不可
    if (w.current) {
      // 通常処理中 → 床仮置きはタイマーを進めない
      w.procTimer -= dt;
      if (w.procTimer <= 0) {
        const finishedDest = w.current!.destination;
        s.bags = s.bags.filter(x => x.id !== w.current!.id);
        w.workloadPt += w.activeProcPt;
        w.activeProcPt = 0;
        w.current = null; w.doneCount++; s.totalDone++;
        w.loadedByDest[finishedDest] = (w.loadedByDest[finishedDest] ?? 0) + 1;
        w.travelTimer = workerTravelTime;
        s.doneByDest[finishedDest]++;
        markDestFinished(s, finishedDest, destLimits);
      }
    } else if (w.activeFloor) {
      // 床仮置き処理中 → 通常処理は開始しない
      w.activeFloor.timer -= dt;
      if (w.activeFloor.timer <= 0) {
        w.workloadPt += w.activeFloor.maxTimer;
        w.floorDoneCount++; s.totalDone++;
        w.loadedByDest[w.activeFloor.destination] = (w.loadedByDest[w.activeFloor.destination] ?? 0) + 1;
        s.doneByDest[w.activeFloor.destination]++;
        markDestFinished(s, w.activeFloor.destination, destLimits);
        w.activeFloor = null;
        w.travelTimer = workerTravelTime;
      }
    } else if (w.travelTimer > 0) {
      // 移動/荷物探し待機中
      w.travelTimer = Math.max(0, w.travelTimer - dt);
    } else {
      // 優先順位: バッチ継続 > [スパース時]床置き優先 > ベルトキュー > [アイドル時]床置き
      if (w.floorBatchActive) {
        if (w.floorQueue.length > 0) {
          // バッチ継続: 次の床仮置きを処理
          w.activeFloor = w.floorQueue.shift()!;
          w.activeFloor.timer = w.activeFloor.maxTimer;
        } else {
          // バッチ完了: ベルトキューへ復帰
          w.floorBatchActive = false;
          if (w.queue.length > 0) {
            w.current = w.queue.shift()!;
            w.procTimer = effectiveProcSeconds(w, w.current.destination, speedOverride);
            w.activeProcPt = w.procTimer;
          }
        }
      } else if (beltSparse && w.floorQueue.length >= floorBatchThreshold && w.queue.length === 0) {
        // ベルトが半分以下かつ床仮置きが閾値以上のとき一括処理
        w.floorBatchActive = true;
        w.activeFloor = w.floorQueue.shift()!;
        w.activeFloor.timer = w.activeFloor.maxTimer;
      } else if (w.queue.length > 0) {
        // 待ちキューを処理
        w.current = w.queue.shift()!;
        w.procTimer = effectiveProcSeconds(w, w.current.destination, speedOverride);
        w.activeProcPt = w.procTimer;
      } else if (w.floorQueue.length > 0) {
        // アイドル中は閾値に関係なく床置きを処理
        w.floorBatchActive = true;
        w.activeFloor = w.floorQueue.shift()!;
        w.activeFloor.timer = w.activeFloor.maxTimer;
      }
      // 両方空の場合は待機
    }
  }

  // 全荷物投入済み & ベルト空のとき、閾値未満の床仮置きも強制フラッシュ
  const assignedSetF = new Set(s.workers.flatMap(w => w.assignedDests));
  const totalLimitF = destLimits.reduce((a, b, i) => assignedSetF.has(i) ? a + b : a, 0);
  const totalSpawnedF = s.spawnedByDest.reduce((a, b, i) => assignedSetF.has(i) ? a + b : a, 0);
  if (totalLimitF > 0 && totalSpawnedF >= totalLimitF) {
    const beltEmpty = s.bags.filter(b => b.state === 'belt').length === 0;
    if (beltEmpty) {
      for (const w of s.workers) {
        if (!w.floorBatchActive && !w.activeFloor && !w.current && w.floorQueue.length > 0) {
          w.floorBatchActive = true;
          w.activeFloor = w.floorQueue.shift()!;
          w.activeFloor.timer = w.activeFloor.maxTimer;
        }
      }
    }
  }


  // 完了時刻の記録
  if (s.completedTime === null) {
    const aSetC = new Set(s.workers.flatMap(w => w.assignedDests));
    const totalLimitC = destLimits.reduce((a, b, i) => aSetC.has(i) ? a + b : a, 0);
    const totalSpawnedC = s.spawnedByDest.reduce((a, b, i) => aSetC.has(i) ? a + b : a, 0);
    const beltEmptyC = s.bags.filter(b => b.state === 'belt').length === 0;
    const allIdleC = s.workers.every(w => w.queue.length === 0 && !w.current && !w.activeFloor && w.floorQueue.length === 0);
    if (totalLimitC > 0 && totalSpawnedC >= totalLimitC && beltEmptyC && allIdleC) {
      s.completedTime = s.time;
    }
  }

  // Record history every second — keep full history (no rolling cap) so x-axis always starts at 0s
  if (s.time - s.lastHist >= 1) {
    s.lastHist = s.time;
    const activeFloor = s.workers.reduce((sum, w) => sum + w.floorQueue.length + (w.activeFloor ? 1 : 0), 0);
    // 便フィルタ表示用に、ベルト上の荷物数を便ごとに集計しておく
    const beltByDest = new Array(NUM_DESTS).fill(0);
    for (const b of s.bags) if (b.state === 'belt') beltByDest[b.destination]++;
    s.hist.push({
      t: s.time,
      belt: s.bags.filter(b => b.state === 'belt').length,
      floor: activeFloor,
      done: s.totalDone,
      queues: s.workers.map(w => w.queue.length + (w.current ? 1 : 0)),
      spawned: s.spawnedByDest.reduce((a, b) => a + b, 0),
      flights: new Set(s.bags.filter(b => b.state === 'belt').map(b => b.destination)).size,
      beltByDest,
      spawnedByDest: s.spawnedByDest.slice(),
      doneByDest: s.doneByDest.slice(),
    });
  }
}

// ── Inline chart drawn inside belt center ────────────────────
// 右軸（投入済み荷物量）の上限をきりのよい数値に切り上げる
function niceCeil(value: number): number {
  if (value <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / magnitude;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * magnitude;
}

// グラフの各系列を表示するかどうか（右サイドパネルのタブで切り替え）
interface ChartSeriesVisible {
  belt: boolean;
  spawned: boolean;
  done: boolean;
  flights: boolean; // 行先便数（右軸）。投入量・処理済とは右軸を共有できないため排他表示
  bucketSpawn: boolean; // 5分ごとの投入量（右軸）。累計値とは桁が異なるため投入量（累計）・行先便数とは排他。処理済とは同時表示可
  // done（処理済）は5分ごとの処理数（右軸・0〜250個固定）。5分ごとの投入量とは同時表示可、投入量（累計）・行先便数とは排他
}

// 棒グラフで表示する集計区間（秒）。「5分ごとの投入量」の区切り幅。
const BUCKET_SEC = 300;

// グラフの「便フィルタ」: 指定した便（destination index）のみに絞り込んで系列を再集計する。
// indicesが空（該当便なし）の場合はグラフ側で「該当する便がありません」を表示する。
interface ChartDestFilter {
  indices: number[];
  label: string; // 注記表示用（HND・NRT・手入力した文字列など）
}

function drawInlineChart(ctx: CanvasRenderingContext2D, s: SimState, innerLaneCapacity: number, outerLaneCapacity: number, visible: ChartSeriesVisible, rect: { x: number; y: number; w: number; h: number }, destFilter: ChartDestFilter | null = null) {
  const { x, y, w, h } = rect;
  const pad = { l: 52, r: 44, t: 48, b: 32 };
  const gw = w - pad.l - pad.r;
  const gh = h - pad.t - pad.b;

  ctx.fillStyle = 'rgba(10,18,36,0.88)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(75,85,99,0.5)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.stroke();

  if (destFilter && destFilter.indices.length === 0) {
    ctx.fillStyle = '#4B5563'; ctx.font = '24px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`該当する便がありません（「${destFilter.label}」）`, x + w / 2, y + h / 2);
    return;
  }

  const rawHist = s.hist;
  if (rawHist.length < 2) {
    ctx.fillStyle = '#4B5563'; ctx.font = '28px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('データ収集中...', x + w / 2, y + h / 2);
    return;
  }

  // 便フィルタが指定されていれば、対象便の内訳だけを合算した系列に差し替える
  const hist = destFilter
    ? rawHist.map(hp => {
        let belt = 0, spawned = 0, done = 0, flights = 0;
        for (const d of destFilter.indices) {
          belt += hp.beltByDest[d] ?? 0;
          spawned += hp.spawnedByDest[d] ?? 0;
          done += hp.doneByDest[d] ?? 0;
          if ((hp.beltByDest[d] ?? 0) > 0) flights++;
        }
        return { t: hp.t, belt, spawned, done, flights };
      })
    : rawHist;

  const maxAll = 250;

  // 常に t=0 から全履歴を表示（0m が左端に固定）
  const startT = 0;
  const endT = hist[hist.length - 1].t;
  const spanT = Math.max(endT - startT, 1);

  const px = (t: number) => x + pad.l + ((t - startT) / spanT) * gw;
  const py = (v: number) => y + pad.t + gh - (v / maxAll) * gh;

  // 「5分ごとの投入量」棒グラフ用に、投入量（累計・spawned）の履歴からBUCKET_SEC刻みの差分を算出する
  const bucketAmounts: { start: number; amount: number }[] = [];
  {
    let curBucket = -1;
    let bucketStartCum = 0;
    let lastCum = 0;
    for (const hp of hist) {
      const bIdx = Math.floor(hp.t / BUCKET_SEC);
      if (bIdx !== curBucket) {
        if (curBucket >= 0) bucketAmounts.push({ start: curBucket * BUCKET_SEC, amount: lastCum - bucketStartCum });
        bucketStartCum = lastCum;
        curBucket = bIdx;
      }
      lastCum = hp.spawned;
    }
    if (curBucket >= 0) bucketAmounts.push({ start: curBucket * BUCKET_SEC, amount: lastCum - bucketStartCum });
  }
  // 「処理済」（5分ごとの処理数）用に、処理済（累計・done）の履歴からBUCKET_SEC刻みの差分を算出する（投入量と同じ方法）
  const doneBucketAmounts: { start: number; amount: number }[] = [];
  {
    let curBucket = -1;
    let bucketStartCum = 0;
    let lastCum = 0;
    for (const hp of hist) {
      const bIdx = Math.floor(hp.t / BUCKET_SEC);
      if (bIdx !== curBucket) {
        if (curBucket >= 0) doneBucketAmounts.push({ start: curBucket * BUCKET_SEC, amount: lastCum - bucketStartCum });
        bucketStartCum = lastCum;
        curBucket = bIdx;
      }
      lastCum = hp.done;
    }
    if (curBucket >= 0) doneBucketAmounts.push({ start: curBucket * BUCKET_SEC, amount: lastCum - bucketStartCum });
  }

  // 右軸: 「5分ごとの投入量」「処理済（5分ごとの処理数）」選択時は常に250個で固定、「行先便数」選択時はその最大値、
  // それ以外は投入済み荷物量（累計・単調増加なので最終値）を基準に上限を決める
  const flightsMaxVal = hist.reduce((m, h) => Math.max(m, h.flights), 0);
  const rightMax = (visible.bucketSpawn || visible.done) ? 250
    : visible.flights ? niceCeil(Math.max(1, flightsMaxVal))
    : niceCeil(hist[hist.length - 1].spawned);
  const pyRight = (v: number) => y + pad.t + gh - (v / rightMax) * gh;

  const yTicks = [0, 50, 100, 150, 200, 250];
  for (const tick of yTicks) {
    const gy = py(tick);
    ctx.strokeStyle = tick === 0 ? '#4B5563' : '#1E293B';
    ctx.lineWidth = tick === 0 ? 1.2 : 1;
    ctx.beginPath(); ctx.moveTo(x + pad.l, gy); ctx.lineTo(x + w - pad.r, gy); ctx.stroke();
  }

  // 5分ごとの投入量（細線・右軸）。各区間の中央時刻の値を細い線でつなぐ。
  // 「ベルト上の荷物」より先に描画することで、重なった際に背面に来るようにする。
  if (visible.bucketSpawn) {
    ctx.save();
    ctx.beginPath();
    bucketAmounts.forEach((b, i) => {
      const bx = px(b.start + BUCKET_SEC / 2);
      const by = pyRight(b.amount);
      if (i === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
    });
    ctx.strokeStyle = '#EC4899'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.restore();
  }

  if (visible.belt) {
    ctx.beginPath();
    hist.forEach((h, i) => {
      const v = Math.min(h.belt as number, maxAll);
      if (i === 0) ctx.moveTo(px(h.t), py(v)); else ctx.lineTo(px(h.t), py(v));
    });
    ctx.strokeStyle = '#3B82F6'; ctx.lineWidth = 1.8; ctx.stroke();
  }

  // 投入済み荷物量（累計・右軸）ライン
  if (visible.spawned) {
    ctx.beginPath();
    hist.forEach((h, i) => {
      const v = h.spawned;
      if (i === 0) ctx.moveTo(px(h.t), pyRight(v)); else ctx.lineTo(px(h.t), pyRight(v));
    });
    ctx.strokeStyle = '#C084FC'; ctx.lineWidth = 1.8; ctx.stroke();
  }

  // 処理済み荷物量（5分ごとの処理数・右軸）ライン。各区間の中央時刻の値をつなぐ
  if (visible.done) {
    ctx.beginPath();
    doneBucketAmounts.forEach((b, i) => {
      const bx = px(b.start + BUCKET_SEC / 2);
      const by = pyRight(b.amount);
      if (i === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
    });
    ctx.strokeStyle = '#22C55E'; ctx.lineWidth = 1.8; ctx.stroke();
  }

  // 行先便数（ベルト上にある荷物の行先の異なり数・右軸）ライン。同一行先便は1便として重複カウントしない。
  if (visible.flights) {
    ctx.beginPath();
    hist.forEach((h, i) => {
      const v = h.flights;
      if (i === 0) ctx.moveTo(px(h.t), pyRight(v)); else ctx.lineTo(px(h.t), pyRight(v));
    });
    ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = 0.6; ctx.stroke();
  }

  // 内側レーン上限（オーバーフロー）ライン（赤・太線・半透明）= 外側上限 + 内側上限
  // 上限を「無限」にしている場合はキャパという概念がなくなるため、赤線・ラベルとも非表示にする
  const laneCapacityTotal = outerLaneCapacity + innerLaneCapacity;
  if (Number.isFinite(laneCapacityTotal)) {
    const innerLineY = py(Math.min(laneCapacityTotal, maxAll));
    if (innerLineY >= y + pad.t && innerLineY <= y + pad.t + gh) {
      ctx.save();
      ctx.strokeStyle = 'rgba(239,68,68,0.5)'; ctx.lineWidth = 2.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x + pad.l, innerLineY); ctx.lineTo(x + w - pad.r, innerLineY); ctx.stroke();
      ctx.fillStyle = '#EF4444'; ctx.font = '20px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`ベルト上の手荷物キャパ: ${laneCapacityTotal}個`, x + pad.l + 2, innerLineY - 1);
      ctx.restore();
    }
  }

  // Y-axis labels（左軸: ベルト上の荷物。文字色は「ベルト上の荷物」の線と同じ青）
  ctx.fillStyle = visible.belt ? '#3B82F6' : '#374151'; ctx.font = '20px sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const tick of yTicks) {
    ctx.fillText(tick === 0 ? '0' : `${tick}個`, x + pad.l - 3, py(tick));
  }

  // Y-axis labels（右軸: 投入量・処理済 または 行先便数 または 5分ごとの投入量。左軸と同じ目盛位置に対応する値を表示）
  // 単位は左軸と同様の付け方（0のときは単位なし）: 投入量・処理済は「個」、行先便数は「便」
  // 行先便数・5分ごとの投入量は右軸を専有する排他系列のため、文字色もその系列の線色に合わせる
  // 処理済のみ選択時は処理済の線色（緑）に合わせる（5分ごとの投入量と同時選択時は共有軸のためグレー）
  const rightUnit = visible.flights ? '便' : '個';
  const rightAxisColor = (visible.bucketSpawn && visible.done) ? '#94A3B8' : visible.bucketSpawn ? '#EC4899' : visible.flights ? '#FBBF24' : visible.done ? '#22C55E' : visible.spawned ? '#94A3B8' : '#374151';
  ctx.fillStyle = rightAxisColor; ctx.font = '18px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const tick of yTicks) {
    const v = Math.round((tick / maxAll) * rightMax);
    ctx.fillText(v === 0 ? '0' : `${v.toLocaleString()}${rightUnit}`, x + w - pad.r + 4, py(tick));
  }

  // X-axis time ticks（開始から60分を超えたら単位を「分」から「時間」表示に切り替える）
  const totalMinutes = endT / 60;
  const useHourUnit = totalMinutes > 60;
  let tickIntervalSec: number;
  if (!useHourUnit) {
    if (totalMinutes <= 2) tickIntervalSec = 30;
    else if (totalMinutes <= 5) tickIntervalSec = 60;
    else if (totalMinutes <= 15) tickIntervalSec = 120;
    else if (totalMinutes <= 30) tickIntervalSec = 300;
    else tickIntervalSec = 600;
  } else {
    const totalHours = totalMinutes / 60;
    if (totalHours <= 3) tickIntervalSec = 1800;       // 30分刻み
    else if (totalHours <= 8) tickIntervalSec = 3600;  // 1時間刻み
    else if (totalHours <= 16) tickIntervalSec = 7200; // 2時間刻み
    else tickIntervalSec = 14400;                      // 4時間刻み
  }

  ctx.font = '18px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let xt = 0;
  while (xt <= endT + tickIntervalSec * 0.01) {
    const gx = px(xt);
    if (gx >= x + pad.l && gx <= x + w - pad.r) {
      ctx.strokeStyle = xt === 0 ? '#4B5563' : '#1F2D3D';
      ctx.lineWidth = xt === 0 ? 1.2 : 1;
      ctx.setLineDash(xt === 0 ? [] : [3, 3]);
      ctx.beginPath(); ctx.moveTo(gx, y + pad.t); ctx.lineTo(gx, y + pad.t + gh); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#64748B';
      let label: string;
      if (xt === 0) {
        label = useHourUnit ? '0時間' : '0分';
      } else if (useHourUnit) {
        const hours = xt / 3600;
        label = `${Number.isInteger(hours) ? hours : hours.toFixed(1)}時間`;
      } else {
        label = `${Math.round(xt / 60)}分`;
      }
      ctx.fillText(label, gx, y + pad.t + gh + 3);
    }
    xt += tickIntervalSec;
  }

  // Legend（1段目: 左軸の系列 / 2段目: 右軸の系列）
  const legLx = x + pad.l;
  const legLy1 = y + 6;
  const legLy2 = legLy1 + 20;
  ctx.textBaseline = 'top';
  ctx.font = '18px sans-serif';

  const legLabel1 = 'ベルト上の荷物（左軸）';
  ctx.fillStyle = visible.belt ? '#3B82F6' : '#374151'; ctx.fillRect(legLx, legLy1, 16, 8);
  ctx.fillStyle = visible.belt ? '#94A3B8' : '#4B5563'; ctx.textAlign = 'left';
  ctx.fillText(legLabel1, legLx + 20, legLy1);

  // 「行先便数」「5分ごとの投入量」選択時は投入量の代わりにそれぞれを2段目に表示する（右軸を共有できないため排他）
  const legLabel2 = visible.bucketSpawn ? '5分ごとの投入量（右軸）' : visible.flights ? '行先便数（右軸）' : '投入量（右軸）';
  const legLabel2Active = visible.flights || visible.bucketSpawn || visible.spawned;
  const legLabel2Color = visible.bucketSpawn ? '#EC4899' : visible.flights ? '#FBBF24' : '#C084FC';
  ctx.fillStyle = legLabel2Active ? legLabel2Color : '#374151'; ctx.fillRect(legLx, legLy2, 16, 8);
  ctx.fillStyle = legLabel2Active ? '#94A3B8' : '#4B5563'; ctx.textAlign = 'left';
  ctx.fillText(legLabel2, legLx + 20, legLy2);

  // 処理済（5分ごとの処理数）は「5分ごとの投入量」と右軸を共有できるため、行先便数選択時以外は表示する
  if (!visible.flights) {
    const legLx3 = legLx + ctx.measureText(legLabel2).width + 30;
    const legLabel3 = '5分ごとの処理済（右軸）';
    ctx.fillStyle = visible.done ? '#22C55E' : '#374151'; ctx.fillRect(legLx3, legLy2, 16, 8);
    ctx.fillStyle = visible.done ? '#94A3B8' : '#4B5563'; ctx.textAlign = 'left';
    ctx.fillText(legLabel3, legLx3 + 20, legLy2);
  }

  // 累計値（全便合計）をグラフ枠内の上端・右寄せで1行表示する
  {
    const totalDirect = s.workers.reduce((sum, wk) => sum + wk.doneCount, 0);
    const [lap1 = 0, lap2 = 0, lap3 = 0, lap4 = 0] = s.pickByLap ?? [];
    const fmt = (v: number) => v.toLocaleString();
    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#94A3B8';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(
      `累床：${fmt(s.totalFloor)}　累直：${fmt(totalDirect)}　累１週：${fmt(lap1)}　累２週：${fmt(lap2)}　累３週：${fmt(lap3)}　累４週以上：${fmt(lap4)}`,
      x + w - 6, y + 4,
    );
  }

  // 便フィルタ適用中は、右パネルの統計（全便合算）とグラフの数値が一致しないことが分かるよう注記する
  // （1段目右端は累計値の表示に使うため、2段目の右端に表示する）
  if (destFilter) {
    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#FDE68A';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(`表示中: 便名に「${destFilter.label}」を含む便のみ`, x + w - 6, legLy2);
  }
}

// ── Stats panel drawn on offscreen canvas (right side of recording) ──
function drawStatsPanel(ctx: CanvasRenderingContext2D, s: SimState, simSpeed: number, offsetX: number) {
  const floorCount = s.workers.reduce((sum, w) => sum + w.floorQueue.length + (w.activeFloor ? 1 : 0), 0);
  const spawned = s.spawnedByDest.reduce((a, b) => a + b, 0);
  const beltCount = s.bags.filter(b => b.state === 'belt').length;
  const overflow = s.totalOverflow;

  ctx.fillStyle = '#030712';
  ctx.fillRect(offsetX, 0, STATS_PANEL_W, SH);

  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(offsetX, 0);
  ctx.lineTo(offsetX, SH);
  ctx.stroke();

  const pad = 16;
  const x = offsetX + pad;
  let y = 16;

  const statLines: { text: string; color: string }[] = [
    { text: `時刻: ${fmtSimTime(s.time)}`, color: '#E5E7EB' },
    { text: `投入済: ${spawned} 個`, color: '#E5E7EB' },
    { text: `ベルト上の荷物: ${beltCount} 個`, color: '#E5E7EB' },
    { text: `処理済: ${s.totalDone} 個`, color: '#E5E7EB' },
    { text: `床仮置き: ${floorCount} 個 / 累計: ${s.totalFloor} 個`, color: '#E5E7EB' },
    { text: `オーバーフロー: ${overflow} 個`, color: overflow > 0 ? '#FB923C' : '#E5E7EB' },
    {
      text: `ベルト半充填: ${s.firstOuterExceedTime !== null ? fmtSimTime(s.firstOuterExceedTime) : '--:--:--'}`,
      color: s.firstOuterExceedTime !== null ? '#EAB308' : '#6B7280',
    },
    {
      text: `緊急停止: ${s.emergencyStopCount} 回 / ${fmtSimTime(s.emergencyStopTotalTime)}`,
      color: s.emergencyStopCount > 0 ? '#EF4444' : '#6B7280',
    },
  ];

  const lineH = 20;
  const boxH = statLines.length * lineH + pad * 2 - 4;
  ctx.fillStyle = '#111827';
  ctx.beginPath(); ctx.roundRect(offsetX + 8, y - 4, STATS_PANEL_W - 16, boxH, 6); ctx.fill();
  ctx.strokeStyle = overflow > 0 ? '#F97316' : '#374151';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(offsetX + 8, y - 4, STATS_PANEL_W - 16, boxH, 6); ctx.stroke();

  ctx.font = '14px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  statLines.forEach((line, i) => {
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, x, y + i * lineH);
  });

  y += boxH + 12;

  ctx.fillStyle = '#111827';
  ctx.beginPath(); ctx.roundRect(offsetX + 8, y, STATS_PANEL_W - 16, 62, 6); ctx.fill();
  ctx.strokeStyle = '#374151'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(offsetX + 8, y, STATS_PANEL_W - 16, 62, 6); ctx.stroke();
  ctx.fillStyle = '#D1D5DB';
  ctx.font = '13px sans-serif';
  ctx.fillText(`シミュレーション速度: ${simSpeed}×`, x, y + 14);
  if (s.completedTime !== null) {
    ctx.fillStyle = '#22C55E';
    ctx.fillText('搭載終了', x, y + 36);
  }

  y += 74;

  ctx.fillStyle = '#111827';
  ctx.beginPath(); ctx.roundRect(offsetX + 8, y, STATS_PANEL_W - 16, 52, 6); ctx.fill();
  ctx.strokeStyle = '#CA8A04'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(offsetX + 8, y, STATS_PANEL_W - 16, 52, 6); ctx.stroke();
  ctx.fillStyle = '#FDE047';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText(`タイムライン: ${fmtSimTime(s.time)}`, x, y + 16);
}

// ── Draw simulation canvas ───────────────────────────────────
function drawSim(ctx: CanvasRenderingContext2D, s: SimState, destQuantities: number[], innerLaneCapacity: number, outerLaneCapacity: number, clockwise: boolean, chartSeriesVisible: ChartSeriesVisible, chartDestFilter: ChartDestFilter | null = null, speedOverrideSeconds: number | null = null) {
  const { workers, bags, beltW: BW, beltH: BH, beltR: BR, beltWidthPx } = s;

  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, SW, SH);

  // ベルト＋作業者＋グラフ（ベルト下）をキャンバス枠に収める一括縮小変換
  const layout = computeSceneLayout(BW, BH, beltWidthPx);
  ctx.save();
  ctx.translate(layout.tx, layout.ty);
  ctx.scale(layout.scale, layout.scale);

  const bx = BCX - BW / 2, by = BCY - BH / 2;

  // Belt shadow
  ctx.save();
  ctx.shadowColor = '#000'; ctx.shadowBlur = 12;
  roundRectPath(ctx, bx, by, BW, BH, BR);
  ctx.strokeStyle = '#1F2937'; ctx.lineWidth = s.beltWidthPx + 8; ctx.stroke();
  ctx.restore();

  // Belt surface
  roundRectPath(ctx, bx, by, BW, BH, BR);
  ctx.strokeStyle = '#374151'; ctx.lineWidth = s.beltWidthPx; ctx.stroke();

  // Belt dashed center line
  roundRectPath(ctx, bx, by, BW, BH, BR);
  ctx.strokeStyle = '#4B5563'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 8]); ctx.stroke(); ctx.setLineDash([]);

  // ベルト内側の空きスペースに、ベルト上を流れている行先便数（重複便名は1便として数える）と、
  // 現在稼働中（表示中）の作業者数をリアルタイムに表示する。作業者数は便数の右側に並べる。
  const flightsOnBeltNow = new Set(bags.filter(b => b.state === 'belt').map(b => b.destination)).size;
  const activeWorkerCountNow = workers.filter(w => w.visible).length;
  // 縦位置はベルト内側下寄りの周回マーク凡例と被らないよう、必要な分だけ上へずらす（beltInnerLayout）。
  // 個別処理速度の注記を出すときは、その1行分（18px）さらに上へずらす（内周の上端は超えない）
  const inner = beltInnerLayout(BW, BH, s.beltWidthPx);
  const showSpeedNote = !!(chartDestFilter && chartDestFilter.indices.length > 0 && speedOverrideSeconds !== null);
  const centerTextY = showSpeedNote
    ? Math.max(inner.innerTop + BELT_CENTER_INFO_HALF_HEIGHT, inner.textY - 18)
    : inner.textY;
  ctx.fillStyle = '#E5E7EB'; ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`ベルト上${flightsOnBeltNow}便分/${activeWorkerCountNow}名配置`, BCX, centerTextY);

  // 便フィルタ（「全便」以外）選択中は、対象便のみ処理速度を個別に上書きしていることをベルト上に明示する
  if (showSpeedNote && chartDestFilter) {
    ctx.fillStyle = '#FBBF24'; ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`⚡ 個別処理速度適用中: ${chartDestFilter.label} ${speedOverrideSeconds}秒/個`, BCX, centerTextY + 28);
  }

  // Belt direction arrows
  for (let i = 0; i < 10; i++) {
    const { pt: [ax, ay], tangent: [tx, ty] } = beltInfo(i / 10, s);
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(Math.atan2(ty, tx) + (clockwise ? 0 : Math.PI));
    ctx.fillStyle = '#6B7280'; ctx.beginPath();
    ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // Dimension arrows and labels
  const arrowOff = 20;
  ctx.strokeStyle = '#9CA3AF';
  ctx.fillStyle = '#9CA3AF';
  ctx.lineWidth = 1;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';

  // Long side dimension (Bottom)
  const lx1 = BCX - BW / 2, lx2 = BCX + BW / 2, ly = BCY + BH / 2 + arrowOff;
  ctx.beginPath();
  ctx.moveTo(lx1, ly); ctx.lineTo(lx2, ly);
  ctx.moveTo(lx1, ly - 5); ctx.lineTo(lx1, ly + 5);
  ctx.moveTo(lx2, ly - 5); ctx.lineTo(lx2, ly + 5);
  ctx.stroke();
  // Arrowheads
  ctx.beginPath(); ctx.moveTo(lx1, ly); ctx.lineTo(lx1 + 8, ly - 3); ctx.lineTo(lx1 + 8, ly + 3); ctx.fill();
  ctx.beginPath(); ctx.moveTo(lx2, ly); ctx.lineTo(lx2 - 8, ly - 3); ctx.lineTo(lx2 - 8, ly + 3); ctx.fill();
  ctx.fillText(`${(BW / PIXELS_PER_METER).toFixed(1)}m`, lx1 + (lx2 - lx1) / 4, ly + 15);

  // Short side dimension (Right)
  const sx = BCX + BW / 2 + arrowOff, sy1 = BCY - BH / 2, sy2 = BCY + BH / 2;
  ctx.beginPath();
  ctx.moveTo(sx, sy1); ctx.lineTo(sx, sy2);
  ctx.moveTo(sx - 5, sy1); ctx.lineTo(sx + 5, sy1);
  ctx.moveTo(sx - 5, sy2); ctx.lineTo(sx + 5, sy2);
  ctx.stroke();
  // Arrowheads
  ctx.beginPath(); ctx.moveTo(sx, sy1); ctx.lineTo(sx - 3, sy1 + 8); ctx.lineTo(sx + 3, sy1 + 8); ctx.fill();
  ctx.beginPath(); ctx.moveTo(sx, sy2); ctx.lineTo(sx - 3, sy2 - 8); ctx.lineTo(sx + 3, sy2 - 8); ctx.fill();
  ctx.save(); ctx.translate(sx + 15, sy1 + (sy2 - sy1) / 4); ctx.rotate(Math.PI / 2);
  ctx.fillText(`${(BH / PIXELS_PER_METER).toFixed(1)}m`, 0, 0); ctx.restore();

  // Inline chart — below the belt (寸法表示の下)
  // グラフはベルトと別の横位置（左枠ぎりぎり）に描くため、ベルト用txとグラフ用chartTxの差の分だけずらして描く
  ctx.save();
  ctx.translate((layout.chartTx - layout.tx) / layout.scale, 0);
  drawInlineChart(ctx, s, innerLaneCapacity, outerLaneCapacity, chartSeriesVisible, layout.chart, chartDestFilter);
  ctx.restore();

  // Injection points — arrow pointing outward (toward belt) from just inside inner edge
  for (const injectPos of INJECT_POSITIONS) {
    const { pt: [ix, iy], normal: [inx, iny] } = beltInfo(injectPos, s);
    const innerEdgeDist = s.beltWidthPx / 2 + 10;
    const arrowCx = ix - inx * innerEdgeDist;
    const arrowCy = iy - iny * innerEdgeDist;
    const aLen = 14, aHalfW = 8;
    const tipX = arrowCx + inx * aLen;
    const tipY = arrowCy + iny * aLen;
    const baseX = arrowCx - inx * aLen;
    const baseY = arrowCy - iny * aLen;
    ctx.save();
    ctx.shadowColor = '#10B981'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#10B981';
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(baseX - iny * aHalfW, baseY + inx * aHalfW);
    ctx.lineTo(baseX + iny * aHalfW, baseY - inx * aHalfW);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#D1FAE5'; ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('投入', arrowCx - inx * 44, arrowCy - iny * 22);
  }

  // 作業者の「済/床」枠は全員のアイコン描画後にまとめて描く（後で描かれる別作業者のアイコンに
  // 枠が隠れてしまわないよう、枠を常に最前面にするため）
  const drawStatsBoxes: (() => void)[] = [];
  // 動いている（搭載中ポーズの）作業者アイコンは「済/床」枠よりさらに後に描いて前面に出す
  const drawMovingWorkerIcons: (() => void)[] = [];

  // ベルト上辺の作業者の上側・下辺の作業者の下側・右辺/左辺の作業者の外側に、担当便の荷物が入る数のコンテナ（1基30個）＋けん引車を並べて描く。
  // 上辺: 作業者アイコン上〜シーン上端の空き（約35px）、下辺: 作業者アイコン下〜ベルト下マージン端の空きに収め、
  // 既存レイアウト（SCENE_MARGIN_TOP / SCENE_MARGIN_BOTTOM_BELT等）は変えない。
  // 上辺は車が左端で左向き、下辺は左右反転して車が右端で右向き（右が進行方向）。
  // 作業者番号の小さい順に1列目へ置き、先に置いた列と重なる場合は2列目（外側）へ置く（1便分は必ず同じ列。各列にけん引車）。
  // コンテナは便数が増えて1列目・2列目で重なっても縮小しない（常に基準サイズ。重なり・外枠からのはみ出しは許容）。
  // 待ち行列の荷物が手前に見えるよう、作業者描画より先に描く。
  {
    // コンテナの寸法（CONTAINER_CAPACITY / CONTAINER_MAX_SIZE / *_RATIO / CONTAINER_GAP / TRAIN_MARGIN）はファイル先頭で定義
    const CONTAINER_BOTTOM_OFFSET = 30; // 上辺: 作業者中心からコンテナ列下端（車輪の下）までの距離（処理中の輪・待ち件数バッジと被らない）
    const CONTAINER_TOP_OFFSET_BOTTOM_SIDE = 33; // 下辺: 作業者中心からコンテナ上端までの距離（床仮置きの「床:n」ラベルと被らない）
    type BeltSide = 'top' | 'bottom' | 'right' | 'left';
    type CItem = { color: string | null; ratio: number };
    const sideOf = (nx: number, ny: number): BeltSide =>
      Math.abs(ny) > Math.abs(nx) ? (ny < 0 ? 'top' : 'bottom') : (nx > 0 ? 'right' : 'left');
    const ROW_GAP = 2;      // 2列にしたときの列と列の間隔
    const gapFor = (u: number) => (u < CONTAINER_MAX_SIZE ? Math.max(1, u * 0.2) : CONTAINER_GAP);
    // u: 横方向の基準サイズ（コンテナ横幅＝u×CONTAINER_WIDTH_RATIO、けん引車＝u×TUG_WIDTH_RATIO 等）
    const rowLen = (k: number, u: number) =>
      u * (TUG_WIDTH_RATIO + TOWBAR_RATIO) + k * u * CONTAINER_WIDTH_RATIO + (k - 1) * gapFor(u);

    for (const side of ['top', 'bottom', 'right', 'left'] as BeltSide[]) {
      const isVerticalSide = side === 'right' || side === 'left';
      // この辺の作業者（作業者番号が小さい順＝優先順）。担当便ごとに「予定投入数÷30」の切り上げ基数のコンテナを作り、
      // その便に割り当てた色で、その作業者がその便を搭載済みの個数（直搭載＋床搭載）分を先頭のコンテナから30個ずつ塗る
      const sideList = workers
        .filter(w => {
          if (!w.visible) return false;
          const { normal: [nx, ny] } = beltInfo(w.pos, s);
          return sideOf(nx, ny) === side;
        })
        .sort((a, b) => a.id - b.id)
        .map(w => {
          const flights: CItem[][] = w.assignedDests.map(d => {
            const m = Math.ceil((destQuantities[d] ?? DEFAULT_DEST_QTY) / CONTAINER_CAPACITY);
            const loadedD = w.loadedByDest?.[d] ?? 0;
            return Array.from({ length: m }, (_, k) => ({
              color: s.destColor?.[d] ?? null,
              ratio: Math.max(0, Math.min(1, (loadedD - k * CONTAINER_CAPACITY) / CONTAINER_CAPACITY)),
            }));
          }).filter(f => f.length > 0);
          const [wx, wy] = workerXY(w, s);
          return { w, wx, wy, flights };
        })
        .filter(e => e.flights.length > 0);
      if (sideList.length === 0) continue;

      // 辺に沿った範囲の制限（右辺・左辺はシーンの上端〜下端に収める）
      const alongMin = isVerticalSide ? layout.boxTop : -Infinity;
      const alongMax = isVerticalSide ? layout.beltAreaBottom : Infinity;

      type Placement = { e: typeof sideList[number]; lane: 0 | 1; items: CItem[] };
      // 横方向サイズ u で、作業者番号順に1列目→2列目の空いている方へ置く。
      // 作業者の全便を1列にまとめて置けなければ、便の区切り（コンテナ数がなるべく半分ずつ）で2列に分けて1列目・2列目に置く。
      // 1便分は必ず同じ列。strict=false のときは入らない列も重なりが一番少ない列に置く（最終手段）
      const tryLayout = (u: number, strict: boolean): Placement[] | null => {
        const lanes: [number, number][][] = [[], []];
        const overlapOf = (lane: 0 | 1, iv: [number, number]) => {
          let ov = 0;
          if (iv[0] < alongMin) ov += alongMin - iv[0];
          if (iv[1] > alongMax) ov += iv[1] - alongMax;
          for (const o of lanes[lane]) {
            const d = Math.min(iv[1], o[1]) - Math.max(iv[0], o[0]) + TRAIN_MARGIN;
            if (d > 0) ov += d;
          }
          return ov;
        };
        const res: Placement[] = [];
        for (const e of sideList) {
          const c = isVerticalSide ? e.wy : e.wx;
          const iv = (k: number): [number, number] => [c - rowLen(k, u) / 2, c + rowLen(k, u) / 2];
          const all = e.flights.flat();
          const ivAll = iv(all.length);
          const freeLane = ([0, 1] as const).find(l => overlapOf(l, ivAll) === 0);
          if (freeLane !== undefined) {
            lanes[freeLane].push(ivAll);
            res.push({ e, lane: freeLane, items: all });
            continue;
          }
          // 便の区切りで2列に分ける
          let split: [CItem[], CItem[]] | null = null;
          if (e.flights.length >= 2) {
            let best = Infinity;
            for (let b = 1; b < e.flights.length; b++) {
              const a = e.flights.slice(0, b).flat(), bb = e.flights.slice(b).flat();
              const diff = Math.abs(a.length - bb.length);
              if (diff < best) { best = diff; split = [a, bb]; }
            }
          }
          if (split) {
            const [a, bb] = split;
            const ivA = iv(a.length), ivB = iv(bb.length);
            const order = ([[0, 1], [1, 0]] as const).find(([la, lb]) => overlapOf(la, ivA) === 0 && overlapOf(lb, ivB) === 0);
            if (order) {
              lanes[order[0]].push(ivA); lanes[order[1]].push(ivB);
              res.push({ e, lane: order[0], items: a }, { e, lane: order[1], items: bb });
              continue;
            }
          }
          if (strict) return null;
          // 最終手段: 全便1列のまま、重なりが一番少ない列に置く
          const lane: 0 | 1 = overlapOf(0, ivAll) <= overlapOf(1, ivAll) ? 0 : 1;
          lanes[lane].push(ivAll);
          res.push({ e, lane, items: all });
        }
        return res;
      };
      // コンテナは便数が増えて1列目・2列目で重なっても縮小しない（横方向・高さとも常に基準サイズ）。
      // 重ならずに置けなければ、重なりが一番少ない列に置く（重なり・外枠からのはみ出しは許容）
      const u = CONTAINER_MAX_SIZE;
      const placements = tryLayout(u, true) ?? tryLayout(u, false)!;
      // （1列の高さ＝h＋車輪(半径max(1, h×0.15))×2）
      const h = u;
      const wheelR = Math.max(1, h * 0.15);
      const rowH = h + wheelR * 2;
      const cw = u * CONTAINER_WIDTH_RATIO;
      const tugW = u * TUG_WIDTH_RATIO;
      const towbarW = u * TOWBAR_RATIO;
      const gap = gapFor(u);

      for (const { e, lane, items } of placements) {
        const { wx, wy } = e;
        ctx.save();
        // 下辺は作業者中心の縦線を軸に左右反転して描く（車が右端・右向き、担当1便目のコンテナが車のすぐ左）。図形のみで文字はないため反転して問題ない
        if (side === 'bottom') { ctx.translate(wx, 0); ctx.scale(-1, 1); ctx.translate(-wx, 0); }
        // 右辺・左辺は上辺の絵を作業者中心で90°回転して描く（作業者の外側に縦方向。車輪はベルト側）。
        // 右辺: +90°（車が上端・上向き）、左辺: −90°（車が下端・下向き）。上辺(左向き)→左辺(下向き)→下辺(右向き)→右辺(上向き)で一周する向き
        if (isVerticalSide) { ctx.translate(wx, wy); ctx.rotate(side === 'right' ? Math.PI / 2 : -Math.PI / 2); ctx.translate(-wx, -wy); }
        ctx.lineWidth = 1;

        // 1列目（lane=0）が作業者に近い側、2列目はその外側。各列は作業者中心に左右対称
        const y0 = side === 'bottom'
          ? wy + CONTAINER_TOP_OFFSET_BOTTOM_SIDE + lane * (rowH + ROW_GAP)
          : wy - CONTAINER_BOTTOM_OFFSET - lane * (rowH + ROW_GAP) - wheelR * 2 - h;
        const rowLeft = wx - rowLen(items.length, u) / 2;
        const containersLeft = rowLeft + tugW + towbarW;

        // けん引車（左向き）: 背の低い車体＋後方（右寄り）の運転席（窓付き）＋車輪2つ。
        // けん引車は基準サイズ（CONTAINER_MAX_SIZE）固定で描く（周囲との重なりは許容）。現在はコンテナも縮小しないため同じ基準サイズになる。
        // 後端（連結棒側）は rowLeft + tugW、車輪下端はコンテナの車輪下端にそろえる
        {
          const tU = CONTAINER_MAX_SIZE;
          const tH = CONTAINER_MAX_SIZE;
          const tTugW = tU * TUG_WIDTH_RATIO;
          const tWheelR = Math.max(1, tH * 0.15);
          const tugLeft = rowLeft + tugW - tTugW;
          const tY0 = y0 + h + wheelR * 2 - tWheelR * 2 - tH; // けん引車の上端（車輪下端＝コンテナ車輪下端）
          const bodyH = tH * 0.5;
          const bodyY = tY0 + tH - bodyH;
          // 車の色はその列の先頭コンテナの便に割り当てた荷物の色。未割り当て（未投入）の間はグレー
          ctx.fillStyle = items[0].color ?? UNASSIGNED_DEST_COLOR;
          ctx.fillRect(tugLeft, bodyY, tTugW, bodyH);
          const cabX = tugLeft + tTugW * 0.5;
          const cabW = tTugW * 0.4;
          const cabY = tY0 + tH * 0.1;
          ctx.fillRect(cabX, cabY, cabW, bodyY - cabY);
          ctx.fillStyle = '#BAE6FD';
          const winPad = Math.max(0.5, Math.min(tU, tH) * 0.08);
          ctx.fillRect(cabX + winPad, cabY + winPad, Math.max(0.5, cabW - winPad * 2), Math.max(0.5, (bodyY - cabY) - winPad * 2));
          ctx.strokeStyle = '#94A3B8';
          ctx.strokeRect(tugLeft, bodyY, tTugW, bodyH);
          ctx.strokeRect(cabX, cabY, cabW, bodyY - cabY);
          ctx.fillStyle = '#9CA3AF';
          for (const tx of [tugLeft + tTugW * 0.25, tugLeft + tTugW * 0.75]) {
            ctx.beginPath();
            ctx.arc(tx, tY0 + tH + tWheelR, tWheelR, 0, Math.PI * 2);
            ctx.fill();
          }
          // 連結棒（けん引車の後端〜その列の先頭コンテナ）
          ctx.strokeStyle = '#9CA3AF';
          ctx.lineWidth = Math.max(1, h * 0.1);
          ctx.beginPath();
          ctx.moveTo(rowLeft + tugW, y0 + h * 0.8);
          ctx.lineTo(containersLeft, y0 + h * 0.8);
          ctx.stroke();
          ctx.lineWidth = 1;
        }

        for (let ci = 0; ci < items.length; ci++) {
          const cx = containersLeft + ci * (cw + gap);
          ctx.fillStyle = 'rgba(148,163,184,0.15)';
          ctx.fillRect(cx, y0, cw, h);
          const { color: fillColor, ratio: fillRatio } = items[ci];
          if (fillRatio > 0 && fillColor) {
            const fillH = h * fillRatio;
            ctx.fillStyle = fillColor;
            ctx.fillRect(cx, y0 + h - fillH, cw, fillH);
          }
          ctx.strokeStyle = '#94A3B8';
          ctx.strokeRect(cx, y0, cw, h);
          // 車輪（コンテナ下辺の横幅1/4・3/4の位置に2つ）
          ctx.fillStyle = '#9CA3AF';
          for (const wxr of [cx + cw * 0.25, cx + cw * 0.75]) {
            ctx.beginPath();
            ctx.arc(wxr, y0 + h + wheelR, wheelR, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }
    }
  }

  // Draw workers（「エクセル読み込み」ルールで担当便の荷物が投入されていない/投入完了した作業者は非表示）
  for (const w of workers) {
    if (!w.visible) continue;
    const [wx, wy] = workerXY(w, s);
    const totalQ = w.queue.length + (w.current ? 1 : 0);
    const col = '#22C55E';
    const { normal: [nx, ny] } = beltInfo(w.pos, s);

    // Queue stack
    const queueBags = [...w.queue];
    if (w.current) queueBags.unshift(w.current);
    for (let qi = 0; qi < queueBags.length; qi++) {
      const b = queueBags[qi];
      const stackX = wx + nx * (20 + qi * 12);
      const stackY = wy + ny * (20 + qi * 12);
      ctx.save(); ctx.shadowColor = b.color; ctx.shadowBlur = 4;
      ctx.fillStyle = qi === 0 && w.current ? b.color : b.color + 'CC';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.5;
      ctx.translate(stackX, stackY); ctx.rotate(Math.atan2(ny, nx));
      ctx.fillRect(-s.bagW / 2, -s.bagH / 2, s.bagW, s.bagH);
      ctx.strokeRect(-s.bagW / 2, -s.bagH / 2, s.bagW, s.bagH);
      ctx.restore();
    }

    // Processing arc
    if (w.current) {
      const progress = 1 - w.procTimer * w.speed;
      ctx.beginPath(); ctx.arc(wx, wy, 22, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.strokeStyle = '#60A5FA'; ctx.lineWidth = 3; ctx.stroke();
    }

    // Worker icon（全身の人型。旧・丸型アイコン（直径40px）とほぼ同じ範囲に収める: 高さ約40px・幅約30px、常に立ち姿）
    // 人型アイコンの色は白（待ち件数バッジは緑の col のまま）
    const iconCol = '#FFFFFF';
    // ポーズ: 'lift' = 腕を斜め上・外側へ上げ頭上に荷物を持つ（ベルトからの搭載中／床からの搭載の後半50%）、
    //         'bend' = 腰をかがめて足元の荷物を取る（床からの搭載の前半50%。画面左向きにかがむ）、'stand' = 通常の立ち姿
    let pose: 'stand' | 'lift' | 'bend' = 'stand';
    let poseBagColor = '';
    if (w.current) {
      pose = 'lift'; poseBagColor = w.current.color;
    } else if (w.activeFloor) {
      const fp = w.activeFloor.maxTimer > 0 ? 1 - w.activeFloor.timer / w.activeFloor.maxTimer : 1;
      pose = fp < 0.5 ? 'bend' : 'lift';
      poseBagColor = w.activeFloor.color;
    }
    // 人型アイコン＋作業者番号の描画。立ち姿のときはこの場で描き（「済/床」枠より背面）、
    // 動いているとき（搭載中のポーズ）は「済/床」枠の描画後に描いて枠より前面にする
    const drawWorkerIcon = () => {
    // 人型アイコンには影（白いぼかし）を付けない
    ctx.save();
    ctx.strokeStyle = iconCol; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // 脚（腰から斜め下へ。全ポーズ共通）
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(wx - 3.5, wy + 7); ctx.lineTo(wx - 6, wy + 19);
    ctx.moveTo(wx + 3.5, wy + 7); ctx.lineTo(wx + 6, wy + 19);
    ctx.stroke();
    ctx.fillStyle = iconCol + '55';
    if (pose === 'bend') {
      // 足元（左前）の荷物
      ctx.save(); ctx.shadowBlur = 0;
      ctx.fillStyle = poseBagColor; ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8;
      ctx.fillRect(wx - 20, wy + 14, 12, 6); ctx.strokeRect(wx - 20, wy + 14, 12, 6);
      ctx.restore();
      // 腕（前に倒した肩から足元の荷物へ下ろす）
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(wx - 11, wy + 0.5); ctx.lineTo(wx - 17, wy + 14);
      ctx.moveTo(wx - 11, wy + 0.5); ctx.lineTo(wx - 11, wy + 14);
      ctx.stroke();
      // 胴体・頭（腰を軸に左へ60°前傾）
      ctx.save();
      ctx.translate(wx, wy + 7); ctx.rotate(-Math.PI / 3);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(-7, -15, 14, 16, 3); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -21.5, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    } else {
      // 腕: 通常は肩から斜め下へ、搭載中は肩から斜め上・外側へ
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      if (pose === 'lift') {
        ctx.moveTo(wx - 7, wy - 6); ctx.lineTo(wx - 11, wy - 19);
        ctx.moveTo(wx + 7, wy - 6); ctx.lineTo(wx + 11, wy - 19);
      } else {
        ctx.moveTo(wx - 7, wy - 6); ctx.lineTo(wx - 13, wy + 5);
        ctx.moveTo(wx + 7, wy - 6); ctx.lineTo(wx + 13, wy + 5);
      }
      ctx.stroke();
      // 胴体・頭
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(wx - 7, wy - 8, 14, 16, 3); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(wx, wy - 14.5, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (pose === 'lift') {
        // 頭上・両手の間に持ち上げた荷物
        ctx.save(); ctx.shadowBlur = 0;
        ctx.fillStyle = poseBagColor; ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8;
        ctx.fillRect(wx - 12, wy - 26, 24, 6); ctx.strokeRect(wx - 12, wy - 26, 24, 6);
        ctx.restore();
      }
    }
    ctx.restore();
    // 作業者番号（胴体の中心に番号のみ。体からはみ出してよい大きさ: 16.5px、3桁は12px。旧サイズ22px/16pxの75%）。
    // 白い体の上でも暗い背景の上でも読めるよう、黒の文字に白の縁取り
    const workerNo = String(w.id + 1);
    ctx.font = `bold ${workerNo.length >= 3 ? 12 : 16.5}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = '#FFFFFF';
    ctx.strokeText(workerNo, pose === 'bend' ? wx - 6 : wx, pose === 'bend' ? wy + 3.5 : wy);
    ctx.fillStyle = '#000000';
    ctx.fillText(workerNo, pose === 'bend' ? wx - 6 : wx, pose === 'bend' ? wy + 3.5 : wy);
    ctx.restore();
    };
    if (pose === 'stand') drawWorkerIcon();
    else drawMovingWorkerIcons.push(drawWorkerIcon);

    // Queue badge
    if (totalQ > 0) {
      const badgeX = wx + 18, badgeY = wy - 18;
      ctx.beginPath(); ctx.arc(badgeX, badgeY, 9, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(totalQ), badgeX, badgeY);
    }

    // Floor queue (床仮置き) - drawn inward from belt
    // 上辺・下辺（縦方向）の作業者か、右辺・左辺（横方向）の作業者かで配置を分ける
    const isVerticalWorkerForFloor = Math.abs(ny) > Math.abs(nx);
    if (w.floorQueue.length > 0 || w.activeFloor) {
      const displayFloor = [...(w.activeFloor ? [w.activeFloor] : []), ...w.floorQueue];
      for (let fi = 0; fi < displayFloor.length; fi++) {
        const fb = displayFloor[fi];
        const isActive = fi === 0 && w.activeFloor !== null;
        let drawX: number, drawY: number;
        if (isVerticalWorkerForFloor) {
          // 上辺・下辺: 左方向へ縦3個ずつのカラムで配置
          const col = Math.floor(fi / 3);
          const row = fi % 3;
          drawX = wx - 33 - col * 13;
          drawY = wy + row * 11 - 11;
        } else {
          // 右辺・左辺: 作業者アイコン（円半径20px＋処理中の輪の半径22px）の真下、
          // ギリギリ被らない位置に詰めて横3個ずつの行で配置
          const pileCy = wy + 33;
          drawX = wx + (fi % 3) * 13 - 13;
          drawY = pileCy + Math.floor(fi / 3) * 11 - 4;
        }
        ctx.fillStyle = fb.color; ctx.strokeStyle = isActive ? '#fff' : '#888'; ctx.lineWidth = isActive ? 1 : 0.5;
        ctx.fillRect(drawX - 5, drawY - 4, 10, 7);
        ctx.strokeRect(drawX - 5, drawY - 4, 10, 7);
        if (isActive) {
          const progress = 1 - fb.timer / fb.maxTimer;
          ctx.fillStyle = '#22C55E';
          ctx.fillRect(drawX - 5, drawY + 3, 10 * progress, 2);
        }
      }
      const totalFloorCount = (w.activeFloor ? 1 : 0) + w.floorQueue.length;
      const labelX = isVerticalWorkerForFloor ? wx - 33 - Math.floor((totalFloorCount - 1) / 3) * 13 : wx;
      const labelY = isVerticalWorkerForFloor ? wy + 22 : wy + 53;
      ctx.fillStyle = '#FEF3C7'; ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(`床:${totalFloorCount}`, labelX, labelY);
    }

    // ── Worker stats box ─────────────────────────────────────
    // Placed to avoid overlapping the belt track, based on which side of the
    // belt the worker sits on (top/bottom → circle右隣、右辺/左辺 → 画面外側ストリップ):
    // 人数が多いときは箱を小さくして重なりを軽減する
    const totalDone = w.doneCount + w.floorDoneCount;
    const totalAssigned = w.assignedDests.reduce(
      (sum, d) => sum + (destQuantities[d] ?? DEFAULT_DEST_QTY), 0
    );
    const floorActive = w.floorQueue.length + (w.activeFloor ? 1 : 0); // 床で処理中の1個も含める（床置きの荷物アイコン・「床:n」と同じ数え方）
    const isVerticalWorker = Math.abs(ny) > Math.abs(nx);
    const compact = workers.length > 6;

    let statsX: number, statsY: number;
    const boxW = compact ? 62 : 90;
    const boxH = compact ? 34 : 40;
    const fontSize = compact ? 14 : 17;
    const lineOffset = fontSize / 2 + 1; // 「済」「床」2行がフォントサイズに応じて被らないようにする縦オフセット
    const line1 = `済 ${totalDone}/${totalAssigned}`;
    const line2 = `床 ${floorActive}個`;

    // クランプ境界はシーン変換の等倍座標系（layout.boxLeft/boxRight/boxTop/beltAreaBottom）を使う。
    // 実キャンバスのSW/SHではない点に注意（シーン全体を縮小しても常にベルトエリア内に収まるように）。
    if (isVerticalWorker) {
      // 上辺・下辺: 作業者サークルの右隣に配置
      statsX = Math.min(layout.boxRight - boxW / 2 - 3, wx + 30 + boxW / 2);
      statsY = Math.max(layout.boxTop + boxH / 2 + 2, Math.min(layout.beltAreaBottom - boxH / 2 - 2, wy));
    } else if (nx > 0) {
      // 右辺: ベルト右外側ストリップ
      statsX = layout.boxRight - boxW / 2 - 5;
      statsY = Math.max(layout.boxTop + boxH / 2 + 3, wy - 30 - boxH / 2);
    } else {
      // 左辺: ベルト左外側ストリップ
      statsX = layout.boxLeft + boxW / 2 + 5;
      statsY = Math.max(layout.boxTop + boxH / 2 + 3, wy - 30 - boxH / 2);
    }

    drawStatsBoxes.push(() => {
      ctx.fillStyle = 'rgba(17,24,39,0.9)';
      ctx.beginPath();
      ctx.roundRect(statsX - boxW / 2, statsY - boxH / 2, boxW, boxH, 5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(75,85,99,0.7)'; ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.roundRect(statsX - boxW / 2, statsY - boxH / 2, boxW, boxH, 5);
      ctx.stroke();

      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.fillStyle = '#86EFAC';
      ctx.fillText(line1, statsX, statsY - lineOffset);
      ctx.fillStyle = '#FCA5A5';
      ctx.fillText(line2, statsX, statsY + lineOffset);
    });
  }

  // 全作業者アイコンの描画が終わってから「済/床」枠を最前面に描画する
  for (const draw of drawStatsBoxes) draw();
  // 動いている作業者アイコンは「済/床」枠と被っても前面に表示する
  for (const draw of drawMovingWorkerIcons) draw();

  // Bags on belt
  const laneOffset = s.beltWidthPx / 4;
  for (const bag of bags) {
    if (bag.state !== 'belt') continue;
    const { pt: [bx2, by2], normal: [nx2, ny2], tangent: [tx, ty] } = beltInfo(bag.pos, s);
    const sign = bag.lane === 1 ? 1 : -1;
    const drawX = bx2 + nx2 * laneOffset * sign;
    const drawY = by2 + ny2 * laneOffset * sign;
    ctx.save(); ctx.translate(drawX, drawY); ctx.rotate(Math.atan2(ty, tx));
    const alpha = bag.circuits === 0 ? 'FF' : bag.circuits === 1 ? 'CC' : '99';
    ctx.fillStyle = bag.color + alpha; ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8;
    ctx.shadowColor = bag.color; ctx.shadowBlur = 5;
    ctx.fillRect(-s.bagW / 2, -s.bagH / 2, s.bagW, s.bagH);
    ctx.strokeRect(-s.bagW / 2, -s.bagH / 2, s.bagW, s.bagH);
    // 周回マーク（荷物アイコンの真ん中に、はみ出ない最大サイズで描く）: 2周目(circuits=1)は△、3周目(circuits=2)は×、4周目以上(circuits>=3)は☆。
    // 記号の色は黒。荷物の色が黒だと見づらい濃い色（LAP_MARK_LIGHT_ON_BAG_COLORS）のときだけ白にする
    if (bag.circuits > 0) {
      ctx.shadowBlur = 0;
      const markColor = LAP_MARK_LIGHT_ON_BAG_COLORS.has(bag.color.toUpperCase()) ? '#FFFFFF' : '#000000';
      const hw = s.bagW / 2 - 0.8, hh = s.bagH / 2 - 0.8; // 荷物の枠線(0.8)の内側
      if (bag.circuits >= 3) {
        // 塗りつぶしの五芒星（荷物の短い方の半辺に収まる大きさ）
        const ro = Math.min(hw, hh), ri = ro * 0.45;
        ctx.fillStyle = markColor;
        ctx.beginPath();
        for (let k = 0; k < 10; k++) {
          const r = k % 2 === 0 ? ro : ri;
          const a = -Math.PI / 2 + (k * Math.PI) / 5;
          if (k === 0) ctx.moveTo(r * Math.cos(a), r * Math.sin(a)); else ctx.lineTo(r * Math.cos(a), r * Math.sin(a));
        }
        ctx.closePath(); ctx.fill();
      } else if (bag.circuits === 2) {
        const lw = 1.8;
        const ix = hw - lw / 2, iy = hh - lw / 2;
        ctx.strokeStyle = markColor; ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(-ix, -iy); ctx.lineTo(ix, iy);
        ctx.moveTo(ix, -iy); ctx.lineTo(-ix, iy);
        ctx.stroke();
      } else {
        ctx.fillStyle = markColor;
        ctx.beginPath();
        ctx.moveTo(0, -hh); ctx.lineTo(-hw, hh); ctx.lineTo(hw, hh);
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
  }

  // 周回マークの凡例＋現在ベルト上の該当荷物数（リアルタイム）を、ベルト内側の下寄りに横1行で表示する。
  // ベルト形状と一緒に縮小し、内周に収まらないときは凡例だけさらに縮小してベルトからはみ出さないようにする
  {
    const lap2 = bags.filter(b => b.state === 'belt' && b.circuits === 1).length;
    const lap3 = bags.filter(b => b.state === 'belt' && b.circuits === 2).length;
    const lap4 = bags.filter(b => b.state === 'belt' && b.circuits >= 3).length;
    const items = [
      { mark: 'tri' as const, text: `2周目 ${lap2}個` },
      { mark: 'x' as const, text: `3周目 ${lap3}個` },
      { mark: 'star' as const, text: `4周目以上 ${lap4}個` },
    ];
    const inner = beltInnerLayout(BW, BH, s.beltWidthPx);
    ctx.save();
    ctx.font = `bold ${LAP_LEGEND_FONT_PX}px sans-serif`;
    const markW = 12, markGap = 5, itemGap = 16, padX = 8;
    const itemWs = items.map(it => markW + markGap + ctx.measureText(it.text).width);
    const boxW = padX * 2 + itemWs.reduce((a, b) => a + b, 0) + itemGap * (items.length - 1);
    const boxH = LAP_LEGEND_BOX_H;
    const k = Math.min(inner.legendScaleH, inner.legendMaxW / boxW);
    ctx.translate(BCX, inner.legendCY); ctx.scale(k, k);
    const boxX = -boxW / 2, boxY = -boxH / 2;
    ctx.fillStyle = 'rgba(17,24,39,0.85)';
    ctx.beginPath(); ctx.roundRect(boxX, boxY, boxW, boxH, 5); ctx.fill();
    ctx.strokeStyle = 'rgba(75,85,99,0.7)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.roundRect(boxX, boxY, boxW, boxH, 5); ctx.stroke();
    let cx = boxX + padX;
    items.forEach((it, i) => {
      const mx = cx + markW / 2;
      const r = markW / 2 - 1;
      if (it.mark === 'tri') {
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.moveTo(mx, -r); ctx.lineTo(mx - r, r); ctx.lineTo(mx + r, r);
        ctx.closePath(); ctx.fill();
      } else if (it.mark === 'x') {
        ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mx - r, -r); ctx.lineTo(mx + r, r);
        ctx.moveTo(mx + r, -r); ctx.lineTo(mx - r, r);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        for (let j = 0; j < 10; j++) {
          const rr = j % 2 === 0 ? r : r * 0.45;
          const a = -Math.PI / 2 + (j * Math.PI) / 5;
          if (j === 0) ctx.moveTo(mx + rr * Math.cos(a), rr * Math.sin(a)); else ctx.lineTo(mx + rr * Math.cos(a), rr * Math.sin(a));
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = '#E5E7EB';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(it.text, cx + markW + markGap, 0);
      cx += itemWs[i] + itemGap;
    });
    ctx.restore();
  }

  // シーン変換（ベルト＋作業者＋グラフの一括縮小）をここで終了。以降は実キャンバス座標系で固定表示。
  ctx.restore();

}

// ── Simulation speed options ─────────────────────────────────
const SIM_SPEED_OPTIONS = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

function fmtSimTime(totalSec: number): string {
  const s = Math.floor(totalSec);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}時間${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}分${String(s % 60).padStart(2, '0')}秒`;
}

// タイムライン（スクラブ）用スナップショットの複製ヘルパー。
// hist は「1秒ごとに追記されるだけで、過去のエントリは書き換わらない」ため、
// JSON往復で丸ごとディープコピーすると（スナップショット数 × hist長）でメモリが二乗的に膨れる。
// hist だけは shallow slice（中身のHistPtオブジェクト自体は複数スナップショット間で共有）にすることで、
// 「その時点までの長さで固定する」というスクラブの正しさを保ったまま複製コストをO(1)に抑える。
function cloneStateForSnapshot(s: SimState): SimState {
  const { hist, ...rest } = s;
  const clone = JSON.parse(JSON.stringify(rest)) as Omit<SimState, 'hist'>;
  return { ...clone, hist: hist.slice() };
}

// 「ピーク時キャプチャ」用: ベルト上荷物数が過去最大を更新するたびに、その瞬間のシミュレーション状態を
// 丸ごと保持しておく（通常再生・「搭載終了」一括計算のどちらから呼んでも同じ挙動になる軽量な純関数）。
interface MaxBeltSnapshot { count: number; snapshot: SimState | null }
function updateMaxBeltSnapshot(s: SimState, ref: { current: MaxBeltSnapshot }) {
  const beltCount = s.bags.filter(b => b.state === 'belt').length;
  if (beltCount > ref.current.count) {
    ref.current = { count: beltCount, snapshot: JSON.parse(JSON.stringify(s)) as SimState };
  }
}

// 「一番手荷物量が多かった便の搭載所要時間」表示用の集計結果。
interface BusiestFlightStat {
  destIndex: number;
  name: string;
  qty: number;
  durationSec: number;
}

// 投入予定数（手荷物量）が最大の便を1つ選び（同数の場合は行先indexが若い方を採用＝任意の1つ）、
// その便の搭載開始（初回投入）〜完了（投入予定数分すべて処理・床仮置き・オーバーフロー破棄済み）までの
// 所要時間を返す。まだ搭載が始まっていない／完了していない便は対象外。対象がなければnull。
function computeBusiestFlightStat(s: SimState, destLimits: number[], flightNames: string[]): BusiestFlightStat | null {
  let bestDest = -1;
  let bestQty = -1;
  for (let d = 0; d < destLimits.length; d++) {
    if (destLimits[d] > bestQty && s.destFirstSpawnTime[d] !== null && s.destCompletionTime[d] !== null) {
      bestQty = destLimits[d];
      bestDest = d;
    }
  }
  if (bestDest === -1) return null;
  const start = s.destFirstSpawnTime[bestDest]!;
  const end = s.destCompletionTime[bestDest]!;
  return { destIndex: bestDest, name: flightNames[bestDest] ?? `行先${bestDest + 1}`, qty: bestQty, durationSec: end - start };
}

// ── Main component ───────────────────────────────────────────
export default function BaggageSimulation() {
  const simCanvasRef          = useRef<HTMLCanvasElement>(null);
  const stateRef              = useRef<SimState | null>(null);
  const lastTsRef             = useRef<number>(0);
  const runningRef            = useRef(false);
  const snapshotsRef          = useRef<SimState[]>([]);
  const scrubIndexRef         = useRef<number | null>(null);
  const lastSnapIdxRef        = useRef<number>(-1);
  const mediaRecorderRef      = useRef<MediaRecorder | null>(null);
  const recordedChunksRef     = useRef<Blob[]>([]);
  // 「ピーク時キャプチャ」用: ベルト上荷物数が過去最大を記録した瞬間の状態
  const maxBeltSnapshotRef    = useRef<MaxBeltSnapshot>({ count: -1, snapshot: null });
  const peakCaptureCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const [hasPeakCapture, setHasPeakCapture] = useState(false);
  const isRecordingRef        = useRef(false);
  const offscreenCanvasRef    = useRef<HTMLCanvasElement | null>(null);
  // 「スタート〜搭載終了まで通し録画」ボタン用: このフラグが立っている間に搭載完了（simCompleted）
  // すると自動で録画を停止する。手動の「録画開始」からの録画には影響しない。
  const autoStopOnCompleteRef = useRef(false);
  // 現在の回で使う乱数シード。「固定」時は常にSIM_RNG_SEED、「ランダム」時はリセット(初期化)のたびに引き直す。
  // 通常再生と搭載終了は必ずこの同じ値を使うことで、同じ回の中では常に一致する結果になる。
  const activeSeedRef         = useRef<number>(SIM_RNG_SEED);

  const [running, setRunning]             = useState(false);
  const [hasStarted, setHasStarted]       = useState(false);
  const [arrivalInterval, setArrivalInterval] = useState(2.75);
  const [beltLongSide, setBeltLongSide]   = useState(DEFAULT_LONG_SIDE);
  const [beltShortSide, setBeltShortSide] = useState(DEFAULT_SHORT_SIDE);
  const [beltWidth, setBeltWidth]         = useState(DEFAULT_BELT_WIDTH_M);
  // シーン全体（ベルト＋作業者＋グラフ）のレイアウト（緊急停止ポップアップの表示位置に使用。
  // 実際の描画は canvas 側の drawSim/drawInlineChart が同じ関数で毎回計算する）
  const sceneLayout = computeSceneLayout(beltLongSide * PIXELS_PER_METER, beltShortSide * PIXELS_PER_METER, beltWidth * PIXELS_PER_METER);
  const [bagLength, setBagLength]         = useState(DEFAULT_BAG_L);
  const [bagWidth, setBagWidth]           = useState(DEFAULT_BAG_W);
  const [beltSpeedMS, setBeltSpeedMS]     = useState(0.4);
  const [simSpeed, setSimSpeed]           = useState(10);
  const [workerCount, setWorkerCount]     = useState(DEFAULT_WORKER_COUNT);
  // 作業負荷ポイントの換算係数（表示時に掛け合わせる。シミュレーション内部は実作業秒数・床置き回数のみを累計）
  const [caloriePtPerSec, setCaloriePtPerSec]   = useState(1);   // カロリーPT: 実作業1秒あたりのPT
  const [backRiskPtPerDrop, setBackRiskPtPerDrop] = useState(0.7); // 直搭載1個あたりの腰痛リスクPT（腰痛リスクPT＝直搭載個数×この値＋床搭載個数×床搭載腰痛リスク）
  const [floorBackRiskPt, setFloorBackRiskPt] = useState(1); // 床搭載1個あたりの腰痛リスクPT
  const [workerSpeeds, setWorkerSpeeds]   = useState<number[]>(
    new Array(MAX_WORKERS).fill(10)
  );
  // 「一括処理時間調整」バー専用の表示値。workerSpeeds[0]（作業1の値）を見て表示すると、
  // 作業1バーを個別に動かした時にも一括バーが連動して見えてしまうため、独立させている。
  const [batchSpeedAdjust, setBatchSpeedAdjust] = useState(10);
  const [floorDropProb, setFloorDropProb]         = useState(0.3);
  const [pickupRate, setPickupRate]               = useState(0.5);
  const [pickupForceThreshold, setPickupForceThreshold] = useState(50);
  const [floorExtraTime, setFloorExtraTime]       = useState(DEFAULT_FLOOR_EXTRA_TIME);
  const [floorMax, setFloorMax]                   = useState(DEFAULT_FLOOR_MAX);
  const [floorBatchThreshold, setFloorBatchThreshold] = useState(5);
  const [beltFloorTrigger, setBeltFloorTrigger]       = useState(90);
  const [workerTravelTime, setWorkerTravelTime]       = useState(2);
  const [outerLaneCapacity, setOuterLaneCapacity] = useState(100);
  const [innerLaneCapacity, setInnerLaneCapacity] = useState(100);
  // ONのとき外側・内側レーン上限を両方とも無限（Infinity）として扱う。オーバーフロー/緊急停止も発生しなくなる。
  const [unlimitedLaneCapacity, setUnlimitedLaneCapacity] = useState(false);
  const effOuterLaneCapacity = unlimitedLaneCapacity ? Infinity : outerLaneCapacity;
  const effInnerLaneCapacity = unlimitedLaneCapacity ? Infinity : innerLaneCapacity;
  const [emergencyMargin, setEmergencyMargin]             = useState(20);
  const [emergencyCollectInterval, setEmergencyCollectInterval] = useState(3);
  const [workerDests, setWorkerDests]     = useState<number[][]>(
    // 最初の4人はこれまで通り便を1つずつ担当、5人目以降は未割当（担当なし）で開始
    Array.from({ length: MAX_WORKERS }, (_, i) => (i < DEFAULT_WORKER_COUNT ? [i] : []))
  );
  const [clockwise, setClockwise] = useState(false);
  const [injectionRuleId, setInjectionRuleId] = useState<string>(INJECTION_RULES[0].id);
  // 乱数シードモード: 'fixed'=常に同じ結果（今までの挙動）/ 'random'=リセットのたびに結果が変わる
  const [rngMode, setRngMode] = useState<'fixed' | 'random'>('fixed');
  const [chartSeriesVisible, setChartSeriesVisible] = useState<ChartSeriesVisible>({ belt: true, spawned: false, done: false, flights: false, bucketSpawn: true });
  const toggleChartSeries = (key: keyof ChartSeriesVisible) => {
    setChartSeriesVisible(prev => {
      if (key === 'flights') {
        // 行先便数は右軸を専有する排他表示。ONにする際は、投入量・処理済・5分ごとの投入量をすべてOFFにする。
        const next = !prev.flights;
        return {
          ...prev,
          flights: next,
          bucketSpawn: next ? false : prev.bucketSpawn,
          spawned: next ? false : prev.spawned,
          done: next ? false : prev.done,
        };
      }
      if (key === 'bucketSpawn') {
        // 5分ごとの投入量は処理済（5分ごとの処理数）と右軸（0〜250個）を共有できる。
        // ONにする際は、行先便数・投入量（累計）をOFFにする（処理済はそのまま）。
        const next = !prev.bucketSpawn;
        return {
          ...prev,
          bucketSpawn: next,
          flights: next ? false : prev.flights,
          spawned: next ? false : prev.spawned,
        };
      }
      // 行先便数がON中は投入量・処理済を、5分ごとの投入量がON中は投入量（累計）を選択できない
      if (prev.flights && (key === 'spawned' || key === 'done')) return prev;
      if (prev.bucketSpawn && key === 'spawned') return prev;
      // 投入量（累計）と処理済（5分ごと）は右軸の桁が異なるため排他。片方をONにするともう片方をOFFにする
      if (key === 'spawned' && !prev.spawned) return { ...prev, spawned: true, done: false };
      if (key === 'done' && !prev.done) return { ...prev, done: true, spawned: false };
      return { ...prev, [key]: !prev[key] };
    });
  };
  // 「エクセル読み込み」ルール用の状態
  // フォーマット: A列=便名（2行目以降）、C列以降=5分刻みの時間帯ごとの投入数（2行目以降）
  const excelFlightEventsRef = useRef<FlightSpawnEvent[]>([]); // 読み込んだ全便の投入スケジュール（時刻順）
  const excelFlightNamesRef = useRef<string[]>([]); // 読み込んだ便名（作業者indexと対応）
  const [excelFileName, setExcelFileName] = useState<string | null>(null);
  const [excelParsedCount, setExcelParsedCount] = useState(0);
  const [excelUnmatchedCount, setExcelUnmatchedCount] = useState(0); // 作業者上限超過でスキップした便数
  const [excelError, setExcelError] = useState<string | null>(null);

  const handleExcelFile = useCallback(async (file: File) => {
    setExcelError(null);
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      // 2行目(index1)以降: A列=便名, C列(index2)以降=5分刻みの時間帯ごとの投入数
      const flightRows: { name: string; counts: number[] }[] = [];
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r] ?? [];
        const rawName = row[0];
        if (rawName === null || rawName === undefined || String(rawName).trim() === '') continue;
        const counts: number[] = [];
        for (let c = 2; c < row.length; c++) {
          const v = Number(row[c]);
          counts.push(Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
        }
        flightRows.push({ name: String(rawName).trim(), counts });
      }

      if (flightRows.length === 0) {
        setExcelError('A列の2行目以降に便名が見つかりませんでした。フォーマットをご確認ください。');
        return;
      }

      const skippedCount = Math.max(0, flightRows.length - MAX_WORKERS);
      const usedFlights = flightRows.slice(0, MAX_WORKERS);

      // 各便・各5分バケットの投入数を、バケット内で均等な間隔の時刻に展開する
      const BUCKET_SEC = 5 * 60;
      const events: FlightSpawnEvent[] = [];
      const totals = new Array(MAX_WORKERS).fill(0);
      usedFlights.forEach((flight, dest) => {
        flight.counts.forEach((count, bucketIdx) => {
          if (count <= 0) return;
          totals[dest] += count;
          const bucketStart = bucketIdx * BUCKET_SEC;
          const interval = BUCKET_SEC / count;
          for (let k = 0; k < count; k++) {
            events.push({ time: bucketStart + interval * (k + 0.5), dest });
          }
        });
      });
      events.sort((a, b) => a.time - b.time);

      if (events.length === 0) {
        setExcelError('C列以降に時間帯別の投入数が見つかりませんでした。フォーマットをご確認ください。');
        return;
      }

      excelFlightEventsRef.current = events;
      excelFlightNamesRef.current = usedFlights.map(f => f.name);
      setExcelFileName(file.name);
      setExcelParsedCount(events.length);
      setExcelUnmatchedCount(skippedCount);

      // 便ごとに作業者を1名ずつ自動割当し、投入数もファイルの内容に合わせる
      setWorkerCount(usedFlights.length);
      setWorkerDests(Array.from({ length: MAX_WORKERS }, (_, i) => (i < usedFlights.length ? [i] : [])));
      setDestQuantities(totals);

      // 読み込んだ内容を、現在のシミュレーション状態にも即反映する
      if (stateRef.current) {
        stateRef.current.flightEvents = events;
        stateRef.current.flightEventIdx = 0;
      }
    } catch (err) {
      setExcelError('ファイルの読み込みに失敗しました。.xlsx / .xls / .csv 形式か確認してください。');
      console.error(err);
    }
  }, []);
  const [destQuantities, setDestQuantities] = useState<number[]>(
    new Array(NUM_DESTS).fill(DEFAULT_DEST_QTY)
  );
  // リセット時の作業者配置（荷物数の多い作業者を下辺・上辺へ）に使う最新の投入数。
  // 投入数の変更だけではリセットしないよう、initSim の依存には入れず ref で参照する
  // （initSim の effect より前に宣言し、同じ描画で投入数が変わった場合も最新値が使われるようにする）
  const destQuantitiesRef = useRef(destQuantities);
  useEffect(() => { destQuantitiesRef.current = destQuantities; }, [destQuantities]);
  const [simCompleted, setSimCompleted]     = useState(false);
  const [scrubValue, setScrubValue]         = useState(0);
  const [snapshotCount, setSnapshotCount]   = useState(0);
  const [stats, setStats] = useState<{
    id: number; q: number; floor: number; done: number; floorDone: number; workloadPt: number;
  }[]>([]);
  const [overlayStats, setOverlayStats] = useState<{ time: number; spawned: number; belt: number; done: number; floor: number; totalFloor: number; overflow: number; firstOuterExceedTime: number | null; firstOverflowTime: number | null; emergencyStopCount: number; emergencyStopTotalTime: number; flightsOnBelt: number; totalFlights: number }>({ time: 0, spawned: 0, belt: 0, done: 0, floor: 0, totalFloor: 0, overflow: 0, firstOuterExceedTime: null, firstOverflowTime: null, emergencyStopCount: 0, emergencyStopTotalTime: 0, flightsOnBelt: 0, totalFlights: 0 });
  const [isEmergencyStop, setIsEmergencyStop] = useState(false);
  // 便ごとに現在割り当てられている荷物の色（右パネルの色見本表示用。未割り当ては null）
  const [destColorsUi, setDestColorsUi] = useState<(string | null)[]>(() => new Array(NUM_DESTS).fill(null));
  const syncDestColorsUi = useCallback((dc: (string | null)[] | undefined) => {
    if (!dc) return;
    setDestColorsUi(prev => (prev.join(',') === dc.join(',') ? prev : dc.slice()));
  }, []);

  // 便（destination index）ごとの表示名。エクセル読み込み時は実際の便名、それ以外はデフォルトの行先名。
  // 「一番手荷物量が多かった便」表示・グラフの「便フィルタ」の両方で使う。
  const flightNames = useMemo(() => Array.from({ length: NUM_DESTS }, (_, d) =>
    injectionRuleId === 'excel-import' && excelFlightNamesRef.current[d]
      ? excelFlightNamesRef.current[d]
      : (DEST_NAMES[d] ?? `行先${d + 1}`)
  // excelFileNameは直接使っていないが、エクセル読み込み完了（excelFlightNamesRef更新）を検知する
  // トリガーとして依存配列に含めている
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [injectionRuleId, excelFileName]);

  // 荷物を全て完了後、一番手荷物量が多かった便の搭載開始〜完了所要時間を計算する。
  // 完了時（simCompleted）にのみ最終スナップショットから算出し、未完了時はnull（非表示）。
  const busiestFlightStat = useMemo<BusiestFlightStat | null>(() => {
    if (!simCompleted) return null;
    const snap = snapshotsRef.current[snapshotsRef.current.length - 1];
    if (!snap) return null;
    return computeBusiestFlightStat(snap, destQuantities, flightNames);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simCompleted, snapshotCount, flightNames]);

  // グラフの「便フィルタ」: 全便／HND／NRT／手入力 のいずれかで、便名に指定文字列を含む便のみに絞り込む。
  // 実際の便名（HND/NRT等の空港コードを含み得る形式）を直接読み込む「エクセル読み込み」モードのときのみ
  // 意味を持つため、UI・フィルタ適用ともにこのモードのときだけ有効にする。
  const [flightFilterMode, setFlightFilterMode] = useState<'all' | 'hnd' | 'nrt' | 'custom'>('all');
  const [flightFilterCustomText, setFlightFilterCustomText] = useState('');
  const isExcelImportMode = injectionRuleId === 'excel-import';

  // エクセル読み込みモードから離れたらフィルタ選択をリセットする（非表示中に選択が残って
  // 意図せずグラフが絞り込まれたままになるのを防ぐ）
  useEffect(() => {
    if (!isExcelImportMode) {
      setFlightFilterMode('all');
      setFlightFilterCustomText('');
    }
  }, [isExcelImportMode]);

  const flightFilterNeedle =
    flightFilterMode === 'hnd' ? 'HND' :
    flightFilterMode === 'nrt' ? 'NRT' :
    flightFilterMode === 'custom' ? flightFilterCustomText.trim() : '';
  const chartDestFilter = useMemo<ChartDestFilter | null>(() => {
    if (!isExcelImportMode || flightFilterMode === 'all' || flightFilterNeedle === '') return null;
    const needle = flightFilterNeedle.toUpperCase();
    const indices = flightNames
      .map((name, d) => ({ name, d }))
      .filter(({ name }) => name.toUpperCase().includes(needle))
      .map(({ d }) => d);
    return { indices, label: flightFilterNeedle };
  }, [isExcelImportMode, flightFilterMode, flightFilterNeedle, flightNames]);

  // 便フィルタで「全便」以外を選択中、その対象便のみに適用する個別処理速度（秒/個）。
  // シミュレーション本体の処理時間計算に反映される（便フィルタが表示だけでなく実際の処理速度も
  // 上書きする、唯一の設定項目）。
  const [filteredFlightSpeed, setFilteredFlightSpeed] = useState<number>(10);
  const speedOverride = useMemo<SpeedOverride | null>(() => {
    if (!chartDestFilter || chartDestFilter.indices.length === 0) return null;
    return { dests: chartDestFilter.indices, seconds: filteredFlightSpeed };
  }, [chartDestFilter, filteredFlightSpeed]);

  const initSim = useCallback(() => {
    // 「ランダム」モードならこの初期化のたびに新しいシードを引く。「固定」モードは常にSIM_RNG_SEED。
    activeSeedRef.current = rngMode === 'random' ? drawRandomSeed() : SIM_RNG_SEED;
    const q = destQuantitiesRef.current;
    const workerLayout = computeWorkerEdgeLayout(workerCount, beltLongSide, beltShortSide,
      computeWorkerLoads(workerCount, workerDests, q), computeWorkerContainerCounts(workerCount, workerDests, q));
    stateRef.current = makeState(
      generateWorkerPositions(workerLayout, workerCount),
      workerSpeeds.slice(0, workerCount),
      workerDests,
      beltLongSide,
      beltShortSide,
      bagLength,
      bagWidth,
      beltWidth,
      excelFlightEventsRef.current,
      activeSeedRef.current,
      workerLayout,
    );
    lastTsRef.current = 0;
    maxBeltSnapshotRef.current = { count: -1, snapshot: null };
    setHasPeakCapture(false);
  }, [workerCount, workerSpeeds, workerDests, beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth, rngMode]);

  useEffect(() => { initSim(); }, [initSim]);

  useEffect(() => {
    let frameId: number;
    const loop = (ts: number) => {
      frameId = requestAnimationFrame(loop);
      if (!stateRef.current) return;
      const s = stateRef.current;
      const now = ts / 1000;
      if (lastTsRef.current === 0) lastTsRef.current = now;
      const wallDt = Math.min(now - lastTsRef.current, 0.1);
      lastTsRef.current = now;

      if (runningRef.current) {
        s.workers.forEach((w, i) => {
          w.speed = 1 / (workerSpeeds[i] ?? 10);
          w.assignedDests = workerDests[i] ?? [];
        });
        const perimMeters = s.beltPerim / PIXELS_PER_METER;
        const circuitsPerSec = beltSpeedMS / perimMeters;
        step(s, wallDt * simSpeed, arrivalInterval, circuitsPerSec, floorDropProb, destQuantities, pickupRate, pickupForceThreshold, effOuterLaneCapacity, effInnerLaneCapacity, floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger, workerTravelTime, emergencyMargin, emergencyCollectInterval, clockwise, injectionRuleId, speedOverride);
        updateMaxBeltSnapshot(s, maxBeltSnapshotRef);
        if (maxBeltSnapshotRef.current.snapshot) setHasPeakCapture(true);

        // 0-5分は30秒刻み、5分以降は300秒刻みでスナップショット保存
        const snapInterval = s.time < 300 ? 30 : 300;
        const snapTime = Math.floor(s.time / snapInterval) * snapInterval;
        if (snapTime > 0 && snapTime > lastSnapIdxRef.current) {
          lastSnapIdxRef.current = snapTime;
          snapshotsRef.current.push(cloneStateForSnapshot(s));
          setSnapshotCount(snapshotsRef.current.length);
        }

        // 全搭載完了で自動停止 + 最終スナップショット保存
        const assignedSet2 = new Set(s.workers.flatMap(w => w.assignedDests));
        const totalLimit2 = destQuantities.reduce((a, b, i) => assignedSet2.has(i) ? a + b : a, 0);
        const totalSpawned2 = s.spawnedByDest.reduce((a, b, i) => assignedSet2.has(i) ? a + b : a, 0);
        const noBelt = s.bags.filter(b => b.state === 'belt').length === 0;
        const allIdle = s.workers.every(w => w.queue.length === 0 && !w.current && !w.activeFloor && w.floorQueue.length === 0);
        if (totalLimit2 > 0 && totalSpawned2 >= totalLimit2 && noBelt && allIdle && runningRef.current) {
          runningRef.current = false;
          setRunning(false);
          setSimCompleted(true);
          snapshotsRef.current.push(cloneStateForSnapshot(s));
          const finalIdx = snapshotsRef.current.length - 1;
          setSnapshotCount(snapshotsRef.current.length);
          scrubIndexRef.current = finalIdx;
          setScrubValue(finalIdx);
        }
      }

      // 完了後はスクラブ選択中のスナップショットを描画、実行中は常にライブ描画
      const displayState =
        !runningRef.current && scrubIndexRef.current !== null
          ? snapshotsRef.current[scrubIndexRef.current] ?? s
          : s;
      const simCtx = simCanvasRef.current?.getContext('2d');
      if (simCtx) {
        drawSim(simCtx, displayState, destQuantities, effInnerLaneCapacity, effOuterLaneCapacity, clockwise, chartSeriesVisible, chartDestFilter, speedOverride?.seconds ?? null);
        if (isRecordingRef.current && offscreenCanvasRef.current && simCanvasRef.current) {
          const offCtx = offscreenCanvasRef.current.getContext('2d');
          if (offCtx) {
            offCtx.drawImage(simCanvasRef.current, 0, 0);
            drawStatsPanel(offCtx, displayState, simSpeed, SW);
          }
        }
      }

      if (Math.floor(now * 10) % 3 === 0) {
        syncDestColorsUi(displayState.destColor);
        setStats(displayState.workers.map(w => ({
          id: w.id,
          q: w.queue.length + (w.current ? 1 : 0),
          floor: w.floorQueue.length + (w.activeFloor ? 1 : 0),
          done: w.doneCount,
          floorDone: w.floorDoneCount,
          workloadPt: w.workloadPt,
        })));
      }
      setOverlayStats({
        time: displayState.time,
        spawned: displayState.spawnedByDest.reduce((a, b) => a + b, 0),
        belt: displayState.bags.filter(b => b.state === 'belt').length,
        done: displayState.totalDone,
        floor: displayState.workers.reduce((sum, w) => sum + w.floorQueue.length + (w.activeFloor ? 1 : 0), 0),
        totalFloor: displayState.totalFloor,
        overflow: displayState.totalOverflow,
        firstOuterExceedTime: displayState.firstOuterExceedTime,
        firstOverflowTime: displayState.firstOverflowTime,
        emergencyStopCount: displayState.emergencyStopCount,
        emergencyStopTotalTime: displayState.emergencyStopTotalTime,
        // 便数は同一行先を1便として重複カウントしない
        flightsOnBelt: new Set(displayState.bags.filter(b => b.state === 'belt').map(b => b.destination)).size,
        totalFlights: new Set(displayState.workers.flatMap(w => w.assignedDests)).size,
      });
      setIsEmergencyStop(displayState.emergencyStop);
    };
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [syncDestColorsUi, arrivalInterval, beltSpeedMS, simSpeed, workerCount, workerSpeeds, floorDropProb, workerDests, destQuantities, pickupRate, pickupForceThreshold, effOuterLaneCapacity, effInnerLaneCapacity, floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger, workerTravelTime, emergencyMargin, emergencyCollectInterval, beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth, clockwise, injectionRuleId, chartSeriesVisible, chartDestFilter, speedOverride]);

  const toggleRunning = () => {
    if (!runningRef.current && scrubIndexRef.current !== null) {
      const snap = snapshotsRef.current[scrubIndexRef.current];
      if (snap) stateRef.current = JSON.parse(JSON.stringify(snap));
      scrubIndexRef.current = null;
    }
    runningRef.current = !runningRef.current;
    setRunning(r => !r);
    if (!hasStarted) setHasStarted(true);
  };
  // useCallback で包み、initSim が変わったときだけ作り直す（handleRecordFullRun の依存を安定させるため）
  const reset = useCallback(() => {
    initSim();
    setRunning(false);
    runningRef.current = false;
    setHasStarted(false);
    setSimCompleted(false);
    snapshotsRef.current = [];
    scrubIndexRef.current = null;
    lastSnapIdxRef.current = -1;
    setScrubValue(0);
    setSnapshotCount(0);
  }, [initSim]);
  const runToCompletion = useCallback(() => {
    // 実行中なら停止、状態をリセットして再初期化
    runningRef.current = false;
    setRunning(false);
    setHasStarted(true);
    setSimCompleted(false);
    snapshotsRef.current = [];
    scrubIndexRef.current = null;
    lastSnapIdxRef.current = -1;
    setScrubValue(0);
    setSnapshotCount(0);
    maxBeltSnapshotRef.current = { count: -1, snapshot: null };
    setHasPeakCapture(false);

    // 現在の回のシード（activeSeedRef）をそのまま使う。ここで引き直すと通常再生とズレるため、
    // 「ランダム」モードでの新しいシード抽選はinitSim（＝リセット）のときだけ行う。
    const workerLayout = computeWorkerEdgeLayout(workerCount, beltLongSide, beltShortSide,
      computeWorkerLoads(workerCount, workerDests, destQuantities), computeWorkerContainerCounts(workerCount, workerDests, destQuantities));
    const s = makeState(
      generateWorkerPositions(workerLayout, workerCount),
      workerSpeeds.slice(0, workerCount),
      workerDests,
      beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth,
      excelFlightEventsRef.current,
      activeSeedRef.current,
      workerLayout,
    );
    stateRef.current = s;

    const perimMeters = s.beltPerim / PIXELS_PER_METER;
    const circuitsPerSec = beltSpeedMS / perimMeters;
    const dt = 2.0; // 2 sim-秒/ステップ
    const MAX_ITER = 100000;

    for (let i = 0; i < MAX_ITER; i++) {
      s.workers.forEach((w, wi) => {
        w.speed = 1 / (workerSpeeds[wi] ?? 10);
        w.assignedDests = workerDests[wi] ?? [];
      });
      step(s, dt, arrivalInterval, circuitsPerSec, floorDropProb, destQuantities,
           pickupRate, pickupForceThreshold, effOuterLaneCapacity, effInnerLaneCapacity, floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger, workerTravelTime, emergencyMargin, emergencyCollectInterval, clockwise, injectionRuleId, speedOverride);
      updateMaxBeltSnapshot(s, maxBeltSnapshotRef);

      // 0-5分は30秒刻み、5分以降は300秒刻みでスナップショット保存
      const snapInterval2 = s.time < 300 ? 30 : 300;
      const snapTime2 = Math.floor(s.time / snapInterval2) * snapInterval2;
      if (snapTime2 > 0 && snapTime2 > lastSnapIdxRef.current) {
        lastSnapIdxRef.current = snapTime2;
        snapshotsRef.current.push(cloneStateForSnapshot(s));
      }

      // 完了判定
      const aSet = new Set(s.workers.flatMap(w => w.assignedDests));
      const tLimit = destQuantities.reduce((a, b, idx2) => aSet.has(idx2) ? a + b : a, 0);
      const tSpawn = s.spawnedByDest.reduce((a, b, idx2) => aSet.has(idx2) ? a + b : a, 0);
      const beltEmpty = s.bags.filter(b => b.state === 'belt').length === 0;
      const idle = s.workers.every(w => w.queue.length === 0 && !w.current && !w.activeFloor && w.floorQueue.length === 0);
      if (tLimit > 0 && tSpawn >= tLimit && beltEmpty && idle) break;
    }

    // 最終スナップショット保存
    snapshotsRef.current.push(cloneStateForSnapshot(s));
    const finalIdx = snapshotsRef.current.length - 1;
    scrubIndexRef.current = finalIdx;

    setSimCompleted(true);
    setSnapshotCount(snapshotsRef.current.length);
    setScrubValue(finalIdx);
    if (maxBeltSnapshotRef.current.snapshot) setHasPeakCapture(true);

    // stats を即時反映
    const snap = snapshotsRef.current[finalIdx];
    syncDestColorsUi(snap.destColor);
    setStats(snap.workers.map(w => ({
      id: w.id,
      q: w.queue.length + (w.current ? 1 : 0),
      floor: w.floorQueue.length + (w.activeFloor ? 1 : 0),
      done: w.doneCount,
      floorDone: w.floorDoneCount,
      workloadPt: w.workloadPt,
    })));
    setOverlayStats({
      time: snap.time,
      spawned: snap.spawnedByDest.reduce((a, b) => a + b, 0),
      belt: snap.bags.filter(b => b.state === 'belt').length,
      done: snap.totalDone,
      floor: snap.workers.reduce((sum, w) => sum + w.floorQueue.length + (w.activeFloor ? 1 : 0), 0),
      totalFloor: snap.totalFloor,
      overflow: snap.totalOverflow,
      firstOuterExceedTime: snap.firstOuterExceedTime,
      firstOverflowTime: snap.firstOverflowTime,
      emergencyStopCount: snap.emergencyStopCount,
      emergencyStopTotalTime: snap.emergencyStopTotalTime,
      flightsOnBelt: new Set(snap.bags.filter(b => b.state === 'belt').map(b => b.destination)).size,
      totalFlights: new Set(snap.workers.flatMap(w => w.assignedDests)).size,
    });
  }, [syncDestColorsUi, workerCount, workerSpeeds, workerDests, beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth,
      beltSpeedMS, arrivalInterval, floorDropProb, destQuantities, pickupRate, pickupForceThreshold,
      effOuterLaneCapacity, effInnerLaneCapacity, floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger, workerTravelTime, emergencyMargin, emergencyCollectInterval, clockwise, injectionRuleId, speedOverride]);

  // 「搭載終了」は重い同期計算のため、実行中はブラウザが完全にブロックされ途中経過を表示できない。
  // クリック直後にスピナー表示だけ先に描画させてから（setTimeoutで1ティック待つ）計算本体を実行し、
  // 実測時間を記憶して次回以降の「見込み時間」表示に使う。
  const [isBatchComputing, setIsBatchComputing] = useState(false);
  const lastBatchComputeMsRef = useRef<number | null>(null);
  const handleRunToCompletionClick = useCallback(() => {
    setIsBatchComputing(true);
    setTimeout(() => {
      const t0 = performance.now();
      runToCompletion();
      lastBatchComputeMsRef.current = performance.now() - t0;
      setIsBatchComputing(false);
    }, 0);
  }, [runToCompletion]);

  const updateWorkerSpeed = (i: number, v: number) => {
    setWorkerSpeeds(prev => { const next = [...prev]; next[i] = v; return next; });
  };
  const updateAllWorkerSpeeds = (v: number) => {
    setWorkerSpeeds(new Array(MAX_WORKERS).fill(v));
    setBatchSpeedAdjust(v);
  };
  const toggleDest = (wi: number, di: number) => {
    setWorkerDests(prev => {
      const next = prev.map(arr => [...arr]);
      const pos = next[wi].indexOf(di);
      if (pos >= 0) next[wi].splice(pos, 1); else next[wi].push(di);
      return next;
    });
  };
  const updateDestQty = (di: number, v: number) => {
    setDestQuantities(prev => { const next = [...prev]; next[di] = Math.max(0, v); return next; });
  };

  const [isRecording, setIsRecording] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);

  // 「pushして本番反映」ボタン（ローカルdev実行時のみ表示・動作）の状態。
  // idle → pushing → done（push完了） / no_changes / error
  // 本番反映はVercelのGitHub連携が自動で行うため、アプリ側では反映完了までの確認はしない。
  type DeployPhase = 'idle' | 'pushing' | 'done' | 'no_changes' | 'error';
  const [deployPhase, setDeployPhase] = useState<DeployPhase>('idle');
  const [deployMessage, setDeployMessage] = useState<string>('');

  const handleDeployClick = useCallback(() => {
    setDeployPhase('pushing');
    setDeployMessage('');
    fetch('/api/deploy', { method: 'POST' })
      .then(r => r.json())
      .then((data: { status: string; sha?: string; message?: string }) => {
        if (data.status === 'pushed') {
          setDeployPhase('done');
        } else if (data.status === 'no_changes') {
          setDeployPhase('no_changes');
        } else {
          setDeployPhase('error');
          setDeployMessage(data.message ?? 'pushに失敗しました');
        }
      })
      .catch((e: Error) => {
        setDeployPhase('error');
        setDeployMessage(e.message);
      });
  }, []);

  const startRecording = useCallback(() => {
    if (!simCanvasRef.current) return;
    recordedChunksRef.current = [];

    const offscreen = document.createElement('canvas');
    offscreen.width = SW + STATS_PANEL_W;
    offscreen.height = SH;
    offscreenCanvasRef.current = offscreen;

    const stream = offscreen.captureStream(60);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `baggage-sim-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    isRecordingRef.current = true;
    setIsRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    isRecordingRef.current = false;
    offscreenCanvasRef.current = null;
    setIsRecording(false);
  }, []);

  // 「スタート〜搭載終了まで通し録画」: リセットして最初から実行を開始し、録画も同時に開始する。
  // 全搭載完了で通常再生が自動停止するタイミング（simCompleted）に合わせて録画も自動停止・書き出しする。
  const handleRecordFullRun = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
    reset();
    autoStopOnCompleteRef.current = true;
    // reset()によるinitSim（状態の再生成）が反映されてから録画・再生を開始する
    requestAnimationFrame(() => {
      startRecording();
      runningRef.current = true;
      setRunning(true);
      setHasStarted(true);
    });
  }, [reset, startRecording]);

  // 通し録画中に搭載が完了したら、自動で録画を停止（＝動画ファイルを書き出し）する。
  useEffect(() => {
    if (simCompleted && autoStopOnCompleteRef.current) {
      autoStopOnCompleteRef.current = false;
      stopRecording();
    }
  }, [simCompleted, stopRecording]);

  // 「ピーク時キャプチャ」: ベルト上荷物数が最大になった瞬間の状態を、オフスクリーンのキャンバスに
  // ベルト＋グラフとして再描画し、PNG画像としてダウンロードする（現在の画面表示には影響しない）。
  const handleCapturePeak = useCallback(() => {
    const snap = maxBeltSnapshotRef.current.snapshot;
    if (!snap) return;
    let canvas = peakCaptureCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = SW;
      canvas.height = SH;
      peakCaptureCanvasRef.current = canvas;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawSim(ctx, snap, destQuantities, effInnerLaneCapacity, effOuterLaneCapacity, clockwise, chartSeriesVisible, chartDestFilter, speedOverride?.seconds ?? null);
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `belt-peak-${Math.round(snap.time)}s.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [destQuantities, effInnerLaneCapacity, effOuterLaneCapacity, clockwise, chartSeriesVisible, chartDestFilter, speedOverride]);

  const copyPublicUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(PUBLIC_SIMULATION_URL);
    } catch {
      // クリップボードAPIが使えない環境向けのフォールバック
      const textarea = document.createElement('textarea');
      textarea.value = PUBLIC_SIMULATION_URL;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setUrlCopied(true);
    window.setTimeout(() => setUrlCopied(false), 2000);
  }, []);

  return (
    <div className="flex flex-col gap-3 p-4 bg-gray-950 min-h-screen text-gray-100">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-bold text-gray-100">
            空港手荷物処理能力シミュレーション
          </h1>
          {BUILD_VERSION_LABEL && (
            <span
              className="text-[11px] font-light text-gray-500"
              title="最終pushの日時（JST）"
            >
              {BUILD_VERSION_LABEL}
            </span>
          )}
        </div>
        <div className="flex gap-2 items-center">
          {process.env.NODE_ENV === 'development' && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleDeployClick}
                disabled={deployPhase === 'pushing'}
                title="現在のワークスペースの変更をgit pushします（本番反映はVercelが自動で行います。ローカル開発時のみ）"
                className={`px-4 py-1.5 rounded text-sm font-medium ${
                  deployPhase === 'done' ? 'bg-emerald-600'
                  : deployPhase === 'error' ? 'bg-red-600 hover:bg-red-700'
                  : deployPhase === 'pushing' ? 'bg-gray-600 cursor-wait'
                  : 'bg-indigo-600 hover:bg-indigo-700'
                }`}
              >
                {deployPhase === 'pushing' ? '⏳ push中…'
                  : deployPhase === 'done' ? '✅ push完了'
                  : deployPhase === 'no_changes' ? 'push完了(変更なし)'
                  : deployPhase === 'error' ? '❌ 失敗（再試行）'
                  : '🚀 pushして本番反映'}
              </button>
              {deployPhase === 'error' && deployMessage && (
                <span className="text-xs text-red-400 max-w-xs truncate" title={deployMessage}>{deployMessage}</span>
              )}
              {deployPhase === 'done' && (
                <a
                  href={PUBLIC_SIMULATION_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-emerald-400 underline"
                >
                  {PUBLIC_SIMULATION_URL} を開く（本番反映まで数分かかります）
                </a>
              )}
            </div>
          )}
          <button
            onClick={handleCapturePeak}
            disabled={!hasPeakCapture}
            title="ベルト上の荷物が最大だった瞬間のベルト・グラフをPNG画像として書き出します"
            className={`px-4 py-1.5 rounded text-sm font-medium ${hasPeakCapture ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-800 text-gray-600 cursor-not-allowed'}`}
          >
            📷 ピーク時キャプチャ
          </button>
          <button
            onClick={copyPublicUrl}
            className={`px-4 py-1.5 rounded text-sm font-medium ${urlCopied ? 'bg-emerald-600' : 'bg-gray-700 hover:bg-gray-600'}`}
            title={PUBLIC_SIMULATION_URL}
          >
            {urlCopied ? '✓ コピーしました' : '🔗 URLをコピー'}
          </button>
          <button
            onClick={toggleRunning}
            className={`px-4 py-1.5 rounded text-sm font-medium ${running ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-green-600 hover:bg-green-700'}`}
          >
            {running ? '⏸ 一時停止' : hasStarted ? '▶ 再開' : '▶ スタート'}
          </button>
          <button onClick={reset} className="px-4 py-1.5 rounded text-sm font-medium bg-gray-700 hover:bg-gray-600">
            ↺ リセット
          </button>
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`px-4 py-1.5 rounded text-sm font-medium ${isRecording ? 'bg-red-600 hover:bg-red-700 animate-pulse' : 'bg-gray-600 hover:bg-gray-500'}`}
          >
            {isRecording ? '⏹ 録画停止' : '⏺ 録画開始'}
          </button>
          <button
            onClick={handleRecordFullRun}
            disabled={running || isRecording || isBatchComputing}
            title="最初からリセットして実行を開始し、全搭載完了で自動的に録画を止めて動画（.webm）を書き出します"
            className={`px-4 py-1.5 rounded text-sm font-medium ${
              running || isRecording || isBatchComputing
                ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
                : 'bg-purple-600 hover:bg-purple-700'
            }`}
          >
            🎬 通し録画（スタート〜搭載終了）
          </button>
        </div>
      </div>

      <div className="flex gap-3 items-start">
        {/* Canvas */}
        <div className="rounded-lg overflow-hidden border border-gray-700 relative flex-1">
          <canvas
            ref={simCanvasRef}
            width={SW}
            height={SH}
            className="block w-full"
            style={{ aspectRatio: `${SW}/${SH}` }}
          />
          {/* 緊急停止ポップアップ（ベルト中央の「便数・作業者数」表示の真上、被らない位置に表示。ベルト内側の空きスペースにギリギリ収まるようクランプ） */}
          {isEmergencyStop && (
            <div
              className="absolute flex items-center gap-1 bg-red-700/90 text-white rounded px-2 py-0.5 border border-red-400 font-bold whitespace-nowrap"
              style={{
                left: `${(sceneLayout.emergencyPopupFinal.x / SW * 100).toFixed(1)}%`,
                top: `${(sceneLayout.emergencyPopupFinal.y / SH * 100).toFixed(1)}%`,
                transform: 'translate(-50%, -50%)',
                fontSize: '11px',
                zIndex: 10,
              }}
            >
              🚨 緊急停止、荷物床置き＆積み込み中
            </div>
          )}

          {/* 一番手荷物量が多かった便の搭載所要時間（全便処理完了後のみ表示）／便フィルタで選択中の
              総便数（フィルタ有効時のみ表示、最多手荷物便の枠の下に並べる）。
              グラフ本体のサイズ・レイアウト計算には影響を与えず、キャンバス右端の枠ギリギリ
              （SCENE_OUTER_MARGIN分の余白のみ）にオーバーレイ表示する。上下位置はグラフ矩形の
              上端（chartFinal.y）を起点に、2つの枠を縦に並べる。 */}
          {(busiestFlightStat || (chartDestFilter && chartDestFilter.indices.length > 0)) && (
            <div
              className="absolute flex flex-col gap-2"
              style={{
                right: `${(SCENE_OUTER_MARGIN / SW * 100).toFixed(1)}%`,
                top: `${(sceneLayout.chartFinal.y / SH * 100).toFixed(1)}%`,
                zIndex: 5,
              }}
            >
              {busiestFlightStat && (
                <div
                  className="bg-gray-900/85 rounded-lg px-2 py-1.5 border border-gray-600 leading-tight"
                  style={{ fontSize: '14px', maxWidth: '150px' }}
                >
                  <div className="text-gray-400 font-semibold mb-0.5">最多手荷物便</div>
                  <div className="text-gray-100 font-bold truncate">{busiestFlightStat.name}（{busiestFlightStat.qty}個）</div>
                  <div className="text-gray-400 mt-1">搭載時間</div>
                  <div className="text-emerald-400 font-bold">{fmtSimTime(busiestFlightStat.durationSec)}</div>
                </div>
              )}
              {chartDestFilter && chartDestFilter.indices.length > 0 && (
                <div
                  className="bg-gray-900/85 rounded-lg px-2 py-1.5 border border-gray-600 leading-tight"
                  style={{ fontSize: '14px', maxWidth: '150px' }}
                >
                  <div className="text-gray-400 font-semibold mb-0.5">便フィルタ選択中</div>
                  <div className="text-teal-400 font-bold">{chartDestFilter.indices.length}便</div>
                </div>
              )}
            </div>
          )}

        </div>

        {/* 右サイドパネル */}
        <div className="flex flex-col gap-3 w-[290px] flex-shrink-0">
          {/* 統計表示 */}
          <div className={`bg-gray-900 rounded-lg p-4 border font-mono space-y-1 ${overlayStats.overflow > 0 ? 'border-orange-500' : 'border-gray-700'}`}>
            <div className="text-gray-200" style={{ fontSize: '14px' }}>時刻: {fmtSimTime(overlayStats.time)}</div>
            <div className="text-gray-200" style={{ fontSize: '14px' }}>投入済: {overlayStats.spawned} 個</div>
            <div className="text-gray-200" style={{ fontSize: '14px' }}>ベルト上の荷物: {overlayStats.belt} 個</div>
            <div className="text-gray-200" style={{ fontSize: '14px' }}>総処理済: {overlayStats.done} 個</div>
            <div className="text-gray-200" style={{ fontSize: '14px' }}>床仮置き: {overlayStats.floor} 個 / 累計: {overlayStats.totalFloor} 個</div>
            <div className="text-gray-200" style={{ fontSize: '14px' }}>ベルト上便数: {overlayStats.flightsOnBelt} 便 / 総便数: {overlayStats.totalFlights} 便</div>
            <div style={{ fontSize: '14px', color: overlayStats.overflow > 0 ? '#FB923C' : '#E5E7EB' }}>
              オーバーフロー: {overlayStats.overflow} 個
            </div>
            <div style={{ fontSize: '14px', color: overlayStats.firstOuterExceedTime !== null ? '#EAB308' : '#6B7280' }}>
              ベルト半充填: {overlayStats.firstOuterExceedTime !== null ? fmtSimTime(overlayStats.firstOuterExceedTime) : '--:--:--'}
            </div>
            <div style={{ fontSize: '14px', color: overlayStats.emergencyStopCount > 0 ? '#EF4444' : '#6B7280' }}>
              緊急停止: {overlayStats.emergencyStopCount} 回 / {fmtSimTime(overlayStats.emergencyStopTotalTime)}
            </div>
          </div>

          {/* シミュレーション速度 */}
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-sm text-gray-300 mb-2">{`シミュレーション速度: ${simSpeed}×`}</div>
              <div className="flex flex-col items-end gap-1 mb-2">
                <button
                  onClick={handleRunToCompletionClick}
                  disabled={isBatchComputing}
                  className={`px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${isBatchComputing ? 'bg-green-900 text-gray-400 cursor-not-allowed' : 'bg-green-700 hover:bg-green-600 text-white'}`}
                >
                  搭載終了
                </button>
                {/* 計算中の見込み時間表示（アイコン＋テキスト）。1回目は実績がないため「計算中...」のみ、
                    2回目以降は前回の実測時間を「見込み」として表示する */}
                {isBatchComputing && (
                  <div className="flex items-center gap-1 text-[10px] text-gray-400 whitespace-nowrap">
                    <span className="inline-block w-2.5 h-2.5 border-2 border-gray-600 border-t-teal-400 rounded-full animate-spin" />
                    <span>
                      計算中...
                      {lastBatchComputeMsRef.current !== null &&
                        `（見込み 約${Math.max(1, Math.round(lastBatchComputeMsRef.current / 1000))}秒）`}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <input
              type="range" min={0} max={SIM_SPEED_OPTIONS.length - 1} step={1}
              value={SIM_SPEED_OPTIONS.indexOf(simSpeed) === -1 ? 0 : SIM_SPEED_OPTIONS.indexOf(simSpeed)}
              onChange={e => setSimSpeed(SIM_SPEED_OPTIONS[Number(e.target.value)])}
              className="w-full accent-blue-500 h-1.5 cursor-pointer"
            />
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-gray-500 mt-1">
              {[1, 25, 50, 75, 100, 500, 1000].map(v => <span key={v}>{v}×</span>)}
            </div>
          </div>

          {/* タイムライン */}
          <div className="bg-gray-900 rounded-lg p-4 border border-yellow-600">
            <div className="text-sm font-semibold text-yellow-300 mb-2">
              タイムライン: {fmtSimTime(overlayStats.time)}
            </div>
            {snapshotCount > 0 ? (
              <input
                type="range"
                min={0}
                max={snapshotCount - 1}
                step={1}
                value={scrubValue}
                onChange={e => {
                  const v = Number(e.target.value);
                  scrubIndexRef.current = v;
                  setScrubValue(v);
                  if (runningRef.current) {
                    runningRef.current = false;
                    setRunning(false);
                  }
                }}
                className="w-full accent-yellow-500 h-1.5 cursor-pointer"
              />
            ) : (
              <div className="text-xs text-gray-600 text-center py-1">
                シミュレーション開始後に表示
              </div>
            )}
          </div>

          {/* グラフ表示切り替えタブ（各線ごとにON/OFFできる） */}
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
            <div className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">グラフ表示</div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => toggleChartSeries('belt')}
                className={`px-3 py-1 rounded text-xs font-medium border ${chartSeriesVisible.belt ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
              >
                ベルト上の荷物
              </button>
              <button
                onClick={() => toggleChartSeries('bucketSpawn')}
                className={`px-3 py-1 rounded text-xs font-medium border ${chartSeriesVisible.bucketSpawn ? 'bg-pink-500 border-pink-300 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
              >
                5分ごとの投入量
              </button>
              <button
                onClick={() => toggleChartSeries('flights')}
                className={`px-3 py-1 rounded text-xs font-medium border ${chartSeriesVisible.flights ? 'bg-amber-500 border-amber-300 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
              >
                行先便数
              </button>
              <button
                onClick={() => toggleChartSeries('spawned')}
                disabled={chartSeriesVisible.flights || chartSeriesVisible.bucketSpawn}
                className={`px-3 py-1 rounded text-xs font-medium border ${(chartSeriesVisible.flights || chartSeriesVisible.bucketSpawn) ? 'bg-gray-900 border-gray-800 text-gray-700 cursor-not-allowed' : chartSeriesVisible.spawned ? 'bg-purple-600 border-purple-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
              >
                投入量
              </button>
              <button
                onClick={() => toggleChartSeries('done')}
                disabled={chartSeriesVisible.flights}
                className={`px-3 py-1 rounded text-xs font-medium border ${chartSeriesVisible.flights ? 'bg-gray-900 border-gray-800 text-gray-700 cursor-not-allowed' : chartSeriesVisible.done ? 'bg-green-600 border-green-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
              >
                処理済
              </button>
            </div>

            {/* 便フィルタ: グラフに表示する便を絞り込む（右パネルの統計は常に全便のまま）。
                「全便」以外を選択中は、対象便のみに適用する個別処理速度も設定できる
                （この処理速度だけはシミュレーション本体の挙動に反映される）。
                実際の便名を直接読み込む「エクセル読み込み」モードのときのみ表示する
                （均等ランダムのデフォルト便名はHND/NRT等を含まない形式のため、フィルタが意味を持たない） */}
            {isExcelImportMode && (
            <div className="mt-3 pt-3 border-t border-gray-800">
              <div className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">便フィルタ（グラフ絞り込み＋個別処理速度）</div>
              <div className="flex gap-2 flex-wrap">
                {([
                  { id: 'all', label: '全便' },
                  { id: 'hnd', label: 'HND' },
                  { id: 'nrt', label: 'NRT' },
                  { id: 'custom', label: '手入力' },
                ] as const).map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setFlightFilterMode(opt.id)}
                    className={`px-3 py-1 rounded text-xs font-medium border ${flightFilterMode === opt.id ? 'bg-teal-600 border-teal-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {flightFilterMode === 'custom' && (
                <input
                  type="text"
                  value={flightFilterCustomText}
                  onChange={e => setFlightFilterCustomText(e.target.value)}
                  placeholder="便名に含まれる文字列を入力（例: JL）"
                  className="mt-2 w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-teal-500"
                />
              )}
              {chartDestFilter && (
                <div className="mt-2 text-xs text-gray-500">
                  該当便: {chartDestFilter.indices.length}便
                  {chartDestFilter.indices.length > 0 && ` （${chartDestFilter.indices.map(d => flightNames[d]).join(' / ')}）`}
                </div>
              )}
              {/* 「全便」以外を選択し、該当便がある場合のみ表示。ここで設定した秒数は、担当作業者の
                  通常速度に代わって、対象便の荷物にのみ適用される（通常処理・床仮置き処理の両方）。 */}
              {chartDestFilter && chartDestFilter.indices.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-800">
                  <Slider
                    label={`選択した便の処理速度: ${filteredFlightSpeed} 秒/個`}
                    min={5} max={15} step={1}
                    value={filteredFlightSpeed}
                    onChange={setFilteredFlightSpeed}
                  />
                </div>
              )}
            </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-4 flex-wrap">

        {/* 全体設定 */}
        <div className="flex-1 min-w-60 bg-gray-900 rounded-lg p-4 border border-gray-700 space-y-3">
          <div className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">全体設定</div>

          {/* 荷物投入ルール切り替えバー
              新しいルールを INJECTION_RULES に追加すると、ここに自動でボタンが増える */}
          <div className="pb-3 border-b border-gray-700">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-gray-300">荷物投入ルール</span>
            </div>
            <div className="flex rounded overflow-hidden border border-gray-600 text-xs font-medium flex-wrap">
              {INJECTION_RULES.map(rule => (
                <button
                  key={rule.id}
                  onClick={() => setInjectionRuleId(rule.id)}
                  title={rule.description}
                  className={`px-3 py-1 ${injectionRuleId === rule.id ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >{rule.label}</button>
              ))}
            </div>
            <div className="text-[11px] text-gray-500 mt-1">
              {getInjectionRule(injectionRuleId).description}
            </div>

            {getInjectionRule(injectionRuleId).needsFileUpload && (
              <div className="mt-2 p-2 bg-gray-800 rounded border border-gray-700">
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="px-2 py-1 bg-blue-700 hover:bg-blue-600 text-white text-[11px] rounded font-medium">
                    ファイルを選択
                  </span>
                  <span className="text-[11px] text-gray-400 truncate">
                    {excelFileName ?? '未選択（A列=便名、C列以降=5分ごとの投入数を2行目から記入したxlsx/xls/csv）'}
                  </span>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleExcelFile(f);
                      e.target.value = '';
                    }}
                  />
                </label>
                {excelFileName && !excelError && (
                  <div className="text-[11px] text-green-500 mt-1">
                    {excelFlightNamesRef.current.length}便 / 計{excelParsedCount}個を読み込み、作業者を自動割当しました
                    {excelUnmatchedCount > 0 && `（作業者上限${MAX_WORKERS}人を超えたため後方の${excelUnmatchedCount}便はスキップ）`}
                  </div>
                )}
                {excelError && (
                  <div className="text-[11px] text-red-400 mt-1">{excelError}</div>
                )}
                <div className="text-[11px] text-gray-500 mt-1">
                  {excelFlightNamesRef.current.length > 0
                    ? `読込便: ${excelFlightNamesRef.current.join(' / ')}`
                    : 'フォーマット: A列=便名(2行目〜) / C列以降=5分ごとの投入数(2行目〜)。1便につき作業者1名を自動割当し、初回投入時に配置・投入完了時に非表示にします。'}
                </div>
              </div>
            )}
          </div>

          {/* 乱数シードモード切り替え: 固定=常に同じ結果 / ランダム=リセットのたびに結果が変わる
              （どちらでも「搭載終了」と通常再生は同じ回の中では必ず一致する） */}
          <div className="pb-3 border-b border-gray-700">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-gray-300">乱数シード</span>
            </div>
            <div className="flex rounded overflow-hidden border border-gray-600 text-xs font-medium flex-wrap">
              <button
                onClick={() => setRngMode('fixed')}
                title="常に同じシードを使うため、リセットしても・搭載終了を連打しても毎回同じ結果になります"
                className={`px-3 py-1 ${rngMode === 'fixed' ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >固定（リセットしても同様）</button>
              <button
                onClick={() => setRngMode('random')}
                title="リセットするたびに新しいシードを引くため、結果が変わります（同じ回の中では通常再生・搭載終了は一致します）"
                className={`px-3 py-1 ${rngMode === 'random' ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >ランダム（リセット毎に変化）</button>
            </div>
            <div className="text-[11px] text-gray-500 mt-1">
              {rngMode === 'random'
                ? 'リセットするたびに投入・ピックアップ等の乱数が引き直されます。同じ回の中では通常再生と搭載終了の結果は一致します。'
                : '常に同じ乱数列を使うため、リセットしても・搭載終了を何度押しても同じ結果になります。'}
            </div>
          </div>

          <Slider label={`荷物の投入間隔: ${arrivalInterval.toFixed(2)} 秒/個`}      min={0.25} max={10}  step={0.25} value={arrivalInterval}    onChange={setArrivalInterval} />
          <Slider label={`ピックアップ率: ${(pickupRate * 100).toFixed(0)}%`} min={0}   max={1}    step={0.05}  value={pickupRate}     onChange={setPickupRate} />
          <Slider label={`100％ピックアップ荷物数（ベルト上）: ${pickupForceThreshold} 個以下`} min={10} max={100} step={5} value={pickupForceThreshold} onChange={setPickupForceThreshold} />
          <Slider label={`床置き確率: ${(floorDropProb * 100).toFixed(0)}%`} min={0}    max={1}    step={0.05}  value={floorDropProb}  onChange={setFloorDropProb} />
          <Slider label={`移動/荷物探し時間: +${workerTravelTime} 秒/個`} min={0} max={10} step={0.5} value={workerTravelTime} onChange={setWorkerTravelTime} />
          <Slider label={`床置き追加時間: +${floorExtraTime} 秒（通常の処理時間に上乗せ）`}           min={0}    max={30}   step={1}     value={floorExtraTime} onChange={setFloorExtraTime} />
          <Slider label={`床仮置き上限: ${floorMax} 個`}                    min={1}    max={20}   step={1}     value={floorMax}       onChange={setFloorMax} />
          <Slider label={`床仮置き一括処理閾値: ${floorBatchThreshold} 個`} min={1}    max={20}   step={1}     value={floorBatchThreshold} onChange={setFloorBatchThreshold} />
          <Slider label={`床仮置き積極化 ベルト数閾値: ${beltFloorTrigger} 個`} min={10} max={200} step={5} value={beltFloorTrigger} onChange={setBeltFloorTrigger} />
          <Slider label={`長辺長さ: ${beltLongSide}m`}                       min={10} max={40}  step={1}     value={beltLongSide}   onChange={setBeltLongSide} />
          <Slider label={`短辺長さ: ${beltShortSide.toFixed(1)}m`}           min={5}  max={25}  step={0.5}   value={beltShortSide}  onChange={setBeltShortSide} />
          <Slider label={`ベルト幅: ${beltWidth.toFixed(1)}m`}               min={0.5} max={3.0} step={0.1}   value={beltWidth}      onChange={setBeltWidth} />
          <Slider label={`荷物長さ: ${bagLength.toFixed(2)}m`}               min={0.3} max={1.2} step={0.01}  value={bagLength}      onChange={setBagLength} />
          <Slider label={`荷物幅: ${bagWidth.toFixed(2)}m`}                 min={0.2} max={0.8} step={0.01}  value={bagWidth}       onChange={setBagWidth} />
          <Slider label={`ベルト速度: ${beltSpeedMS.toFixed(2)} m/秒`}        min={0.1} max={1.5} step={0.05} value={beltSpeedMS}      onChange={setBeltSpeedMS} />
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-300">回転方向</span>
            <div className="flex rounded overflow-hidden border border-gray-600 text-xs font-medium">
              <button
                onClick={() => setClockwise(false)}
                className={`px-3 py-1 ${!clockwise ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >反時計回り</button>
              <button
                onClick={() => setClockwise(true)}
                className={`px-3 py-1 ${clockwise ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >時計回り</button>
            </div>
          </div>
          {/* 外側・内側レーン上限を両方とも無限にするチェックボックス。ONの場合はグラフの赤線・キャパ表示も消える */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={unlimitedLaneCapacity}
              onChange={e => setUnlimitedLaneCapacity(e.target.checked)}
              className="accent-blue-500 w-4 h-4 cursor-pointer"
            />
            <span className="text-xs text-gray-300">レーン上限を無限にする（外側・内側とも）</span>
          </label>
          <Slider
            label={unlimitedLaneCapacity ? '外側レーン上限: ∞' : `外側レーン上限: ${outerLaneCapacity} 個`}
            min={10} max={200} step={5} value={outerLaneCapacity} onChange={setOuterLaneCapacity}
            disabled={unlimitedLaneCapacity}
          />
          <Slider
            label={unlimitedLaneCapacity ? '内側レーン上限: ∞' : `内側レーン上限: ${innerLaneCapacity} 個`}
            min={10} max={200} step={5} value={innerLaneCapacity} onChange={setInnerLaneCapacity}
            disabled={unlimitedLaneCapacity}
          />
          <Slider
            label={unlimitedLaneCapacity ? '緊急停止荷物数（ベルト上）: ∞ - ' + emergencyMargin + ' 個' : `緊急停止荷物数（ベルト上）: ${outerLaneCapacity + innerLaneCapacity}個 - ${emergencyMargin} 個`}
            min={0} max={50} step={5} value={emergencyMargin} onChange={setEmergencyMargin}
          />
          <Slider label={`緊急停止床置き時間: ${emergencyCollectInterval} 秒/個`} min={0}   max={10}   step={0.5}   value={emergencyCollectInterval} onChange={setEmergencyCollectInterval} />
        </div>

        {/* 作業者別設定 */}
        <div className="flex-1 min-w-60 bg-gray-900 rounded-lg p-4 border border-gray-700 space-y-4">
          <div className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">作業者別処理速度</div>
          <div className="pb-2 border-b border-gray-700">
            <Slider
              label={`作業者人数: ${workerCount}人`}
              min={1} max={50} step={1}
              value={workerCount}
              onChange={setWorkerCount}
            />
          </div>
          <div className="pb-2 border-b border-gray-700">
            <Slider
              label={`一括処理時間調整: ${batchSpeedAdjust} 秒/個`}
              min={5} max={15} step={1}
              value={batchSpeedAdjust}
              onChange={updateAllWorkerSpeeds}
            />
          </div>
          <div className="pb-2 border-b border-gray-700">
            <Slider
              label={`カロリーPT＝累積作業時秒数 × ${caloriePtPerSec.toFixed(1)} PT/秒`}
              min={0} max={10} step={0.5}
              value={caloriePtPerSec}
              onChange={setCaloriePtPerSec}
            />
            <div className="grid grid-cols-2 gap-3">
              <Slider
                label={`直搭載腰痛リスク: ${backRiskPtPerDrop.toFixed(1)} PT/回`}
                min={0} max={10} step={0.1}
                value={backRiskPtPerDrop}
                onChange={setBackRiskPtPerDrop}
              />
              <Slider
                label={`床搭載腰痛リスク: ${floorBackRiskPt.toFixed(1)} PT/回`}
                min={0} max={10} step={0.1}
                value={floorBackRiskPt}
                onChange={setFloorBackRiskPt}
              />
            </div>
          </div>
          {Array.from({ length: workerCount }, (_, i) => {
            const st = stats[i];
            const q = st?.q ?? 0;
            const col = q >= 6 ? 'text-red-400' : q >= 3 ? 'text-yellow-400' : 'text-green-400';
            // 搭載率（直搭載＋床搭載が0のときは0除算を避けて「—」表示）
            const directDone = st?.done ?? 0;
            const floorDoneN = st?.floorDone ?? 0;
            const loadedTotal = directDone + floorDoneN;
            const floorRatePct = loadedTotal > 0 ? `${Math.round((floorDoneN / loadedTotal) * 100)}` : '—';
            const directRatePct = loadedTotal > 0 ? `${Math.round((directDone / loadedTotal) * 100)}` : '—';
            return (
              <div key={i}>
                <Slider
                  label={`作業${i + 1}: ${workerSpeeds[i] ?? 10} 秒/個　担当: ${
                    // 担当便名とその便の予定投入数（行先便別投入数設定／エクセル読込の値）を並べて表示
                    (workerDests[i] ?? []).length > 0
                      ? (workerDests[i] ?? []).map(d => `${flightNames[d]}（${destQuantities[d] ?? 0}個）`).join(' / ')
                      : 'なし'
                  }`}
                  min={5} max={15} step={1}
                  value={workerSpeeds[i] ?? 10}
                  onChange={(v) => updateWorkerSpeed(i, v)}
                />
                <div className={`text-xs ${col} ml-2 mt-1`}>
                  待ち: {q}個 / 処理済: {loadedTotal}個 / 直搭載: {directDone}個 / 床搭載: {floorDoneN}個
                </div>
                <div className="text-xs ml-2 mt-1">
                  <span className="text-amber-300">{Math.round((st?.workloadPt ?? 0) * caloriePtPerSec)} カロリーPT</span>
                  <span className="text-gray-500"> / </span>
                  <span className="text-rose-300">{Math.round(directDone * backRiskPtPerDrop + floorDoneN * floorBackRiskPt)} 腰痛リスクPT（＝直＋床）</span>
                </div>
                <div className="text-xs text-gray-300 ml-2 mt-1">
                  床搭載率 {floorRatePct}% / 直搭載率 {directRatePct}%
                </div>
              </div>
            );
          })}
        </div>

        {/* 待ち行列比較 */}
        <div className="flex-1 min-w-48 bg-gray-900 rounded-lg p-4 border border-gray-700">
          <div className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">待ち行列比較</div>
          {stats.slice(0, workerCount).map((st, i) => {
            const total = st.q + st.floor;
            const maxScale = 20;
            const qRatio = Math.min(st.q / maxScale, 1);
            const floorRatio = Math.min(st.floor / maxScale, 1);
            const col = total >= 11 ? 'bg-red-500' : total >= 6 ? 'bg-yellow-500' : 'bg-green-500';
            const floorCol = total >= 11 ? 'bg-red-300' : total >= 6 ? 'bg-yellow-300' : 'bg-green-300';
            const isMax = total === Math.max(...stats.slice(0, workerCount).map(s => s.q + s.floor));
            return (
              <div key={i} className="mb-3">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs w-10 text-gray-400">作業{i + 1}</span>
                  <div className="flex-1 bg-gray-800 rounded h-4 overflow-hidden flex">
                    <div className={`h-full transition-all duration-200 ${col}`} style={{ width: `${qRatio * 100}%` }} />
                    <div className={`h-full transition-all duration-200 ${floorCol} opacity-70`} style={{ width: `${floorRatio * 100}%` }} />
                  </div>
                  <span className={`text-xs w-6 text-right ${isMax && total > 0 ? 'text-red-400 font-bold' : 'text-gray-400'}`}>{total}</span>
                  {isMax && total >= 5 && <span className="text-red-400 text-xs">⚠</span>}
                </div>
                <div className="flex gap-3 ml-12 text-xs text-gray-500">
                  <span>待ち: {st.q}個</span>
                  <span>床: {st.floor}個</span>
                  <span>済: {st.done + st.floorDone}個</span>
                </div>
              </div>
            );
          })}
          <div className="mt-3 pt-3 border-t border-gray-700 text-xs text-gray-500 space-y-1">
            <div>■ 濃色: 待ちキュー　■ 淡色: 床仮置き</div>
            <div>△ 2周目の荷物</div>
            <div>× 3周目の荷物</div>
            <div>☆ 4周目以上の荷物</div>
            <div>床仮置き: 処理速度+{floorExtraTime}秒・最大{floorMax}個</div>
          </div>
        </div>

      </div>

      {/* 行先便別投入数設定 */}
      <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
        <div className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">
          行先便別投入数設定（デフォルト: {DEFAULT_DEST_QTY}個）
        </div>
        <div className="grid grid-cols-5 gap-3 sm:grid-cols-10">
          {DEST_NAMES.map((name, di) => (
            <div key={di} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: destColorsUi[di] ?? UNASSIGNED_DEST_COLOR }} />
                <span className="text-xs text-gray-300 font-medium truncate">{name}</span>
              </div>
              <input
                type="number"
                min={0} max={9999}
                value={destQuantities[di]}
                onChange={e => updateDestQty(di, parseInt(e.target.value) || 0)}
                className="w-full bg-gray-800 border rounded px-2 py-1 text-sm text-gray-200 text-center focus:outline-none focus:border-blue-500"
                style={{ borderColor: (destColorsUi[di] ?? UNASSIGNED_DEST_COLOR) + '66' }}
              />
            </div>
          ))}
        </div>
        <div className="mt-2 text-xs text-gray-500">
          合計: {destQuantities.reduce((a, b) => a + b, 0).toLocaleString()} 個
        </div>
      </div>

      {/* 担当便設定 */}
      <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
        <div className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">担当便設定（複数選択可）</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4">
          {DEST_NAMES.map((name, di) => (
            <div key={di} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block flex-shrink-0" style={{ backgroundColor: destColorsUi[di] ?? UNASSIGNED_DEST_COLOR }} />
              <span className="text-xs text-gray-400">{name}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: workerCount }, (_, wi) => (
            <div key={wi} className="bg-gray-800 rounded-lg p-3 border border-gray-700">
              <div className="text-xs font-bold text-gray-200 mb-2">作業{wi + 1}</div>
              <div className="flex flex-wrap gap-1">
                {DEST_NAMES.map((name, di) => {
                  const isSelected = workerDests[wi]?.includes(di) ?? false;
                  return (
                    <button
                      key={di}
                      onClick={() => toggleDest(wi, di)}
                      className={`px-1.5 py-0.5 rounded text-xs font-medium transition-all border ${
                        isSelected ? 'border-white/60 opacity-100 scale-105' : 'border-transparent opacity-25 hover:opacity-50'
                      }`}
                      style={{ backgroundColor: destColorsUi[di] ?? UNASSIGNED_DEST_COLOR, color: '#fff' }}
                      title={name}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
              <div className="text-xs text-gray-500 mt-2">
                {(workerDests[wi]?.length ?? 0) === 0
                  ? '担当なし（全スルー）'
                  : `${workerDests[wi]?.length}便 / ${
                      workerDests[wi]?.reduce((s, d) => s + (destQuantities[d] ?? DEFAULT_DEST_QTY), 0).toLocaleString()
                    }個担当`}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Reusable slider ──────────────────────────────────────────
function Slider({ label, min, max, step, value, onChange, disabled }: {
  label: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  return (
    <div>
      <div className={`text-xs mb-1 ${disabled ? 'text-gray-600' : 'text-gray-300'}`}>{label}</div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        disabled={disabled}
        className={`w-full h-1.5 ${disabled ? 'accent-gray-600 cursor-not-allowed' : 'accent-blue-500 cursor-pointer'}`}
      />
    </div>
  );
}
