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
const WORKER_MIN_GAP_PX = 60; // 同じ辺に並ぶ作業者アイコン（直径約40px、発光エフェクト込みで見た目はもう少し大きい）同士の最低間隔(px, 等倍時)

// ── 作業者人数 ────────────────────────────────────────────────
const DEFAULT_WORKER_COUNT = 4;
const MAX_WORKERS = 100;

// 作業者は「作業1」から順に、下辺→上辺→右辺→左辺の順番でラウンドロビンに配置する。
// （5人目は再び下辺、6人目は上辺…というように便数に応じて作業Noを増やしながら巡回する）
// t=0が上辺中央、t=0.25が右辺中央、t=0.5が下辺中央、t=0.75が左辺中央になる
// （beltInfoの円周パラメータ化の対称性により、ベルトの縦横比によらず常にこの位置になる）。
// 右辺・左辺はアイコンが密集しやすいため最大2名までとし、それを超える分は上辺・下辺
// （人数制限なし）に振り分ける。上辺・下辺が交互に埋まるので、なるべく均等に広がり
// アイコン同士が被りにくくなる。
const QUADRANT_FRAC = 0.25; // 隣り合う辺の中心同士は常にちょうど周長の1/4離れている（上記の対称性より）
const WORKER_EDGE_ORDER: { center: number; lengthKey: 'W_IN' | 'H_IN'; capacity: number }[] = [
  { center: 0.5,  lengthKey: 'W_IN', capacity: Infinity }, // 下辺（人数制限なし）
  { center: 0.0,  lengthKey: 'W_IN', capacity: Infinity }, // 上辺（人数制限なし）
  { center: 0.25, lengthKey: 'H_IN', capacity: 2 },        // 右辺（最大2名）
  { center: 0.75, lengthKey: 'H_IN', capacity: 2 },        // 左辺（最大2名）
];
function generateWorkerPositions(n: number, beltLongSideM: number, beltShortSideM: number): number[] {
  const BW = beltLongSideM * PIXELS_PER_METER;
  const BH = beltShortSideM * PIXELS_PER_METER;
  const BR = Math.min(BW, BH) * 0.25;
  const W_IN = BW - 2 * BR;
  const H_IN = BH - 2 * BR;
  const CORNER = (Math.PI / 2) * BR;
  const PERIM = 2 * W_IN + 2 * H_IN + 4 * CORNER;
  const edgeLength = { W_IN, H_IN };

  // 下辺→上辺→右辺→左辺の順に1人ずつ巡回して割り当てる。定員に達した辺は飛ばして次の辺に回す
  // （右辺・左辺が2名で埋まった後は、残りは自動的に上辺・下辺のみを交互に巡回する）。
  const edgeAssign: number[][] = WORKER_EDGE_ORDER.map(() => []);
  let edgeIdx = 0;
  for (let i = 0; i < n; i++) {
    for (let skip = 0; edgeAssign[edgeIdx % 4].length >= WORKER_EDGE_ORDER[edgeIdx % 4].capacity && skip < 4; skip++) {
      edgeIdx++;
    }
    edgeAssign[edgeIdx % 4].push(i);
    edgeIdx++;
  }

  const positions = new Array(n).fill(0);
  WORKER_EDGE_ORDER.forEach((edge, ei) => {
    const idxs = edgeAssign[ei];
    const count = idxs.length;
    if (count === 0) return;
    const edgeLenFrac = edgeLength[edge.lengthKey] / PERIM;
    // コーナー付近を避けるため辺の中央80%を基本にしつつ、短い辺（右辺・左辺など）で
    // アイコン（直径約40px）同士が被ってしまう場合は、被らない最低限の間隔を確保できる
    // 幅まで広げる。t=0/0.25/0.5/0.75の対称性により、隣の辺の中心までは常にちょうど
    // 周長の1/4離れているため、そこへ食い込みすぎない範囲（1/4の約90%）を上限にする。
    const naturalSpanFrac = edgeLenFrac * 0.8;
    // 隣接アイコン間の間隔を WORKER_MIN_GAP_PX 以上にするための幅（隣接ギャップ = usableLenFrac/count * PERIM）
    const neededSpanFrac = count > 1 ? (WORKER_MIN_GAP_PX * count) / PERIM : 0;
    const usableLenFrac = Math.min(Math.max(naturalSpanFrac, neededSpanFrac), QUADRANT_FRAC * 1.8);
    idxs.forEach((workerIdx, slot) => {
      const frac = count === 1 ? 0.5 : (slot + 0.5) / count;
      const offset = (frac - 0.5) * usableLenFrac;
      positions[workerIdx] = ((edge.center + offset) % 1 + 1) % 1;
    });
  });

  return positions;
}

// ── Bag sizing (defaults) ───────────────────────────────────
const DEFAULT_BAG_L = 0.65; // meters
const DEFAULT_BAG_W = 0.43; // meters

// ── Injection points ─────────────────────────────────────────
const INJECT_POSITIONS = [0.25, 0.75];

// ── Destinations ─────────────────────────────────────────────
// エクセル読み込みルールでは便ごとに1つの行先枠を使うため、作業者上限と同数まで確保する
const NUM_DESTS = MAX_WORKERS;
const DEST_COLORS = [
  '#3B82F6', '#F59E0B', '#10B981', '#EF4444',
  '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16',
  '#F97316', '#14B8A6',
  '#A855F7', '#F43F5E', '#0EA5E9', '#22C55E',
  '#EAB308', '#6366F1', '#D946EF', '#FB7185',
  '#2DD4BF', '#FACC15',
];
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
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  tx: number; ty: number; // ctx.translate(tx,ty) の後に ctx.scale(scale,scale) して使う
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
  // 横方向は中央寄せではなく左端をSCENE_OUTER_MARGINに固定する（＝グラフが常に左枠ぎりぎりに
  // 寄るようにする。高さ側が縮小のボトルネックになる形状では、中央寄せだと余白が左右に分散して
  // グラフが枠の左端から離れてしまうため）。縦方向は従来通り中央寄せのまま。
  const availW = SW - SCENE_OUTER_MARGIN * 2;
  const availH = SH - SCENE_OUTER_MARGIN * 2;
  const scale = Math.min(availW / groupW, availH / groupH, 1);
  const tx = SCENE_OUTER_MARGIN - boxLeft * scale;
  const ty = (SH - groupH * scale) / 2 - boxTop * scale;

  // 緊急停止ポップアップは、ベルト中央の「便数・作業者数」テキストの真上、被らない位置に配置する。
  // ベルトが内側に囲む空きスペースの縦方向の半分の高さ（＝トラック内周までの距離）を超えない
  // 範囲でギリギリ収まるよう、ベルトの短辺・幅に応じてオフセットをクランプする。
  const innerHalfHeight = beltH / 2 - beltWidthPx / 2;
  const clearOffsetY = BELT_CENTER_INFO_HALF_HEIGHT + EMERGENCY_POPUP_GAP_Y + EMERGENCY_POPUP_HALF_HEIGHT;
  const maxFitOffsetY = innerHalfHeight - EMERGENCY_POPUP_HALF_HEIGHT;
  const emergencyOffsetY = Math.max(20, Math.min(clearOffsetY, maxFitOffsetY));

  return {
    scale, tx, ty,
    boxLeft, boxRight, boxTop, beltAreaBottom,
    chart: { x: chartX, y: chartY, w: CHART_NATURAL_W, h: chartH },
    chartFinal: {
      x: tx + chartX * scale,
      y: ty + chartY * scale,
      w: CHART_NATURAL_W * scale,
      h: chartH * scale,
    },
    beltCenterFinal: { x: tx + BCX * scale, y: ty + BCY * scale },
    emergencyPopupFinal: { x: tx + BCX * scale, y: ty + (BCY - emergencyOffsetY) * scale },
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
  assignedDests: number[];
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
  // シード固定の擬似乱数（再現性確保のため Math.random() の代わりに使う）
  rng: () => number;
  // 便（destination）ごとの搭載開始時刻（初回投入時刻）・完了時刻（投入予定数分の処理・床仮置き・
  // オーバーフロー破棄がすべて完了した時刻）。「一番手荷物量が多かった便の搭載所要時間」表示に使う。
  destFirstSpawnTime: (number | null)[];
  destFinishedCount: number[];
  destCompletionTime: (number | null)[];
  // 便（destination）ごとの処理済み累計（通常処理完了＋床仮置き処理完了のみ。オーバーフロー破棄は含まない。
  // グローバル集計のtotalDoneと同じ数え方を便単位で保持する）。グラフの便フィルタ用。
  doneByDest: number[];
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
    assignedDests: assignedDests[i] ?? [],
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
    rng: mulberry32(rngSeed),
    destFirstSpawnTime: new Array(NUM_DESTS).fill(null),
    destFinishedCount: new Array(NUM_DESTS).fill(0),
    destCompletionTime: new Array(NUM_DESTS).fill(null),
    doneByDest: new Array(NUM_DESTS).fill(0),
  };
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
    id: s.nextId++, pos: actualPos, color: DEST_COLORS[dest], destination: dest,
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
  if (count === 1) worker.visible = true;
  if (destLimits[dest] > 0 && count >= destLimits[dest]) worker.visible = false;
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
        const spawnPos = INJECT_POSITIONS[s.rng() < 0.5 ? 0 : 1];
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
              rng: s.rng,
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
              s.nextSpawn += arrivalInterval * (0.6 + s.rng() * 0.8);
              continue;
            }

            if (!placeBagOnBelt(s, dest, spawnPos, outerLaneCapacity)) {
              // 両レーン全周で空きなし → 先行インクリメントを戻して再試行
              s.spawnedByDest[dest]--;
              s.nextSpawn += arrivalInterval * (0.6 + s.rng() * 0.8);
              continue;
            }
          }
          s.nextSpawn += arrivalInterval * (0.6 + s.rng() * 0.8);
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
      if (s.rng() >= effectivePickupRate) continue;

      const forceFloor = beltBagCount >= beltFloorTrigger;
      if (w.floorQueue.length + (w.activeFloor ? 1 : 0) < floorMax && (forceFloor || s.rng() < floorDropProb)) {
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
        w.current = null; w.doneCount++; s.totalDone++;
        w.travelTimer = workerTravelTime;
        s.doneByDest[finishedDest]++;
        markDestFinished(s, finishedDest, destLimits);
      }
    } else if (w.activeFloor) {
      // 床仮置き処理中 → 通常処理は開始しない
      w.activeFloor.timer -= dt;
      if (w.activeFloor.timer <= 0) {
        w.floorDoneCount++; s.totalDone++;
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
            w.current = w.queue.shift()!; w.procTimer = effectiveProcSeconds(w, w.current.destination, speedOverride);
          }
        }
      } else if (beltSparse && w.floorQueue.length >= floorBatchThreshold && w.queue.length === 0) {
        // ベルトが半分以下かつ床仮置きが閾値以上のとき一括処理
        w.floorBatchActive = true;
        w.activeFloor = w.floorQueue.shift()!;
        w.activeFloor.timer = w.activeFloor.maxTimer;
      } else if (w.queue.length > 0) {
        // 待ちキューを処理
        w.current = w.queue.shift()!; w.procTimer = effectiveProcSeconds(w, w.current.destination, speedOverride);
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

function queueColor(qLen: number): string {
  if (qLen < 3) return '#22C55E';
  if (qLen < 6) return '#EAB308';
  return '#EF4444';
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
  bucketSpawn: boolean; // 5分ごとの投入量（棒グラフ・右軸）。累計値とは桁が異なるため排他表示
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

  // 右軸: 「5分ごとの投入量」選択時は常に250個で固定、「行先便数」選択時はその最大値、
  // それ以外は投入済み荷物量（累計・単調増加なので最終値）を基準に上限を決める
  const flightsMaxVal = hist.reduce((m, h) => Math.max(m, h.flights), 0);
  const rightMax = visible.bucketSpawn ? 250
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
      i === 0 ? ctx.moveTo(bx, by) : ctx.lineTo(bx, by);
    });
    ctx.strokeStyle = '#EC4899'; ctx.lineWidth = 0.6; ctx.stroke();
    ctx.restore();
  }

  if (visible.belt) {
    ctx.beginPath();
    hist.forEach((h, i) => {
      const v = Math.min(h.belt as number, maxAll);
      i === 0 ? ctx.moveTo(px(h.t), py(v)) : ctx.lineTo(px(h.t), py(v));
    });
    ctx.strokeStyle = '#3B82F6'; ctx.lineWidth = 1.8; ctx.stroke();
  }

  // 投入済み荷物量（累計・右軸）ライン
  if (visible.spawned) {
    ctx.beginPath();
    hist.forEach((h, i) => {
      const v = h.spawned;
      i === 0 ? ctx.moveTo(px(h.t), pyRight(v)) : ctx.lineTo(px(h.t), pyRight(v));
    });
    ctx.strokeStyle = '#C084FC'; ctx.lineWidth = 1.8; ctx.stroke();
  }

  // 処理済み荷物量（累計・右軸）ライン
  if (visible.done) {
    ctx.beginPath();
    hist.forEach((h, i) => {
      const v = h.done;
      i === 0 ? ctx.moveTo(px(h.t), pyRight(v)) : ctx.lineTo(px(h.t), pyRight(v));
    });
    ctx.strokeStyle = '#22C55E'; ctx.lineWidth = 1.8; ctx.stroke();
  }

  // 行先便数（ベルト上にある荷物の行先の異なり数・右軸）ライン。同一行先便は1便として重複カウントしない。
  if (visible.flights) {
    ctx.beginPath();
    hist.forEach((h, i) => {
      const v = h.flights;
      i === 0 ? ctx.moveTo(px(h.t), pyRight(v)) : ctx.lineTo(px(h.t), pyRight(v));
    });
    ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = 1.8; ctx.stroke();
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
  const rightUnit = visible.flights ? '便' : '個';
  const rightAxisColor = visible.bucketSpawn ? '#EC4899' : visible.flights ? '#FBBF24' : (visible.spawned || visible.done) ? '#94A3B8' : '#374151';
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

  // 「行先便数」「5分ごとの投入量」選択時は投入量・処理済の代わりにそれぞれを2段目に表示する（右軸を共有できないため排他）
  const legLabel2 = visible.bucketSpawn ? '5分ごとの投入量（右軸）' : visible.flights ? '行先便数（右軸）' : '投入量（右軸）';
  const legLabel2Active = visible.flights || visible.bucketSpawn || visible.spawned;
  const legLabel2Color = visible.bucketSpawn ? '#EC4899' : visible.flights ? '#FBBF24' : '#C084FC';
  ctx.fillStyle = legLabel2Active ? legLabel2Color : '#374151'; ctx.fillRect(legLx, legLy2, 16, 8);
  ctx.fillStyle = legLabel2Active ? '#94A3B8' : '#4B5563'; ctx.textAlign = 'left';
  ctx.fillText(legLabel2, legLx + 20, legLy2);

  if (!visible.flights && !visible.bucketSpawn) {
    const legLx3 = legLx + ctx.measureText(legLabel2).width + 30;
    const legLabel3 = '処理済（右軸）';
    ctx.fillStyle = visible.done ? '#22C55E' : '#374151'; ctx.fillRect(legLx3, legLy2, 16, 8);
    ctx.fillStyle = visible.done ? '#94A3B8' : '#4B5563'; ctx.textAlign = 'left';
    ctx.fillText(legLabel3, legLx3 + 20, legLy2);
  }

  // 便フィルタ適用中は、右パネルの統計（全便合算）とグラフの数値が一致しないことが分かるよう注記する
  if (destFilter) {
    ctx.font = '16px sans-serif';
    ctx.fillStyle = '#FDE68A';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(`表示中: 便名に「${destFilter.label}」を含む便のみ`, x + w - 8, y + 6);
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
function drawSim(ctx: CanvasRenderingContext2D, s: SimState, now: number, destQuantities: number[], innerLaneCapacity: number, outerLaneCapacity: number, clockwise: boolean, chartSeriesVisible: ChartSeriesVisible, chartDestFilter: ChartDestFilter | null = null, speedOverrideSeconds: number | null = null) {
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
  ctx.fillStyle = '#E5E7EB'; ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`ベルト上${flightsOnBeltNow}便分/${activeWorkerCountNow}名配置`, BCX, BCY);

  // 便フィルタ（「全便」以外）選択中は、対象便のみ処理速度を個別に上書きしていることをベルト上に明示する
  if (chartDestFilter && chartDestFilter.indices.length > 0 && speedOverrideSeconds !== null) {
    ctx.fillStyle = '#FBBF24'; ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`⚡ 個別処理速度適用中: ${chartDestFilter.label} ${speedOverrideSeconds}秒/個`, BCX, BCY + 28);
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
  drawInlineChart(ctx, s, innerLaneCapacity, outerLaneCapacity, chartSeriesVisible, layout.chart, chartDestFilter);

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
    ctx.fillStyle = '#D1FAE5'; ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('投入', arrowCx - inx * 44, arrowCy - iny * 22);
  }

  // Bottleneck detection（非表示中の作業者は対象外）
  const visibleWorkers = workers.filter(w => w.visible);
  const bottleneck = visibleWorkers.length > 0 ? visibleWorkers.reduce((a, b) => {
    const qa = a.queue.length + (a.current ? 1 : 0);
    const qb = b.queue.length + (b.current ? 1 : 0);
    return qa >= qb ? a : b;
  }) : null;
  const bottleneckQueue = bottleneck ? bottleneck.queue.length + (bottleneck.current ? 1 : 0) : 0;

  // 作業者の「済/床」枠は全員のアイコン描画後にまとめて描く（後で描かれる別作業者のアイコンに
  // 枠が隠れてしまわないよう、枠を常に最前面にするため）
  const drawStatsBoxes: (() => void)[] = [];

  // Draw workers（「エクセル読み込み」ルールで担当便の荷物が投入されていない/投入完了した作業者は非表示）
  for (const w of workers) {
    if (!w.visible) continue;
    const [wx, wy] = workerXY(w, s);
    const totalQ = w.queue.length + (w.current ? 1 : 0);
    const col = queueColor(totalQ);
    const isBottleneck = w === bottleneck && bottleneckQueue >= 3;
    const { normal: [nx, ny] } = beltInfo(w.pos, s);

    if (isBottleneck) {
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(now * 3));
      ctx.save(); ctx.shadowColor = '#EF4444'; ctx.shadowBlur = 20 * pulse;
      ctx.beginPath(); ctx.arc(wx, wy, 28 * pulse * 0.8 + 12, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(239,68,68,${pulse * 0.9})`; ctx.lineWidth = 3; ctx.stroke(); ctx.restore();
    }

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

    // Worker circle
    ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(wx, wy, 20, 0, Math.PI * 2);
    ctx.fillStyle = col + '33'; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#F9FAFB'; ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('作業', wx, wy - 9);
    ctx.fillText(String(w.id + 1), wx, wy + 9);

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

    if (isBottleneck) {
      ctx.save(); ctx.fillStyle = '#FEF2F2'; ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center'; ctx.shadowColor = '#EF4444'; ctx.shadowBlur = 8;
      ctx.fillText('⚠ 渋滞', wx, wy + 32); ctx.restore();
    }

    // ── Worker stats box ─────────────────────────────────────
    // Placed to avoid overlapping the belt track, based on which side of the
    // belt the worker sits on (top/bottom → circle右隣、右辺/左辺 → 画面外側ストリップ):
    // 人数が多いときは箱を小さくして重なりを軽減する
    const totalDone = w.doneCount + w.floorDoneCount;
    const totalAssigned = w.assignedDests.reduce(
      (sum, d) => sum + (destQuantities[d] ?? DEFAULT_DEST_QTY), 0
    );
    const floorActive = w.floorQueue.length;
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
    if (bag.circuits > 0) {
      if (bag.circuits >= 3) {
        const cx = s.bagW / 2 - 3, cy = -s.bagH / 2 + 3, sz = 2.5;
        ctx.strokeStyle = '#EF4444'; ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(cx - sz, cy - sz); ctx.lineTo(cx + sz, cy + sz);
        ctx.moveTo(cx + sz, cy - sz); ctx.lineTo(cx - sz, cy + sz);
        ctx.stroke();
      } else {
        const tx = s.bagW / 2 - 3, ty = -s.bagH / 2 + 4;
        ctx.fillStyle = '#EAB308';
        ctx.beginPath();
        ctx.moveTo(tx, ty - 3.5); ctx.lineTo(tx - 3.5, ty + 2.5); ctx.lineTo(tx + 3.5, ty + 2.5);
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore();
  }

  // シーン変換（ベルト＋作業者＋グラフの一括縮小）をここで終了。以降は実キャンバス座標系で固定表示。
  ctx.restore();

  // Legend — top-right, also above belt
  ctx.fillStyle = 'rgba(17,24,39,0.87)';
  ctx.beginPath(); ctx.roundRect(SW - 148, 5, 140, 62, 7); ctx.fill();
  [{ color: '#22C55E', label: '余裕あり' }, { color: '#EAB308', label: '混雑中' }, { color: '#EF4444', label: '渋滞！' }]
    .forEach(({ color, label }, i) => {
      ctx.beginPath(); ctx.arc(SW - 132, 20 + i * 16, 5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.fillStyle = '#D1D5DB'; ctx.font = '10px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, SW - 122, 20 + i * 16);
    });


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
  const [workerSpeeds, setWorkerSpeeds]   = useState<number[]>(
    new Array(MAX_WORKERS).fill(10)
  );
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
      if (key === 'flights' || key === 'bucketSpawn') {
        // 行先便数・5分ごとの投入量はどちらも右軸を専有する排他表示。
        // ONにする際は、投入量・処理済・もう一方の排他系列をすべてOFFにする。
        const next = !prev[key];
        return {
          ...prev,
          flights: key === 'flights' ? next : false,
          bucketSpawn: key === 'bucketSpawn' ? next : false,
          spawned: next ? false : prev.spawned,
          done: next ? false : prev.done,
        };
      }
      // 排他系列（行先便数／5分ごとの投入量）がON中は投入量・処理済を選択できない
      if ((prev.flights || prev.bucketSpawn) && (key === 'spawned' || key === 'done')) return prev;
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
  const [simCompleted, setSimCompleted]     = useState(false);
  const [scrubValue, setScrubValue]         = useState(0);
  const [snapshotCount, setSnapshotCount]   = useState(0);
  const [stats, setStats] = useState<{
    id: number; q: number; floor: number; done: number; floorDone: number;
  }[]>([]);
  const [overlayStats, setOverlayStats] = useState<{ time: number; spawned: number; belt: number; done: number; floor: number; totalFloor: number; overflow: number; firstOuterExceedTime: number | null; firstOverflowTime: number | null; emergencyStopCount: number; emergencyStopTotalTime: number; flightsOnBelt: number; totalFlights: number }>({ time: 0, spawned: 0, belt: 0, done: 0, floor: 0, totalFloor: 0, overflow: 0, firstOuterExceedTime: null, firstOverflowTime: null, emergencyStopCount: 0, emergencyStopTotalTime: 0, flightsOnBelt: 0, totalFlights: 0 });
  const [isEmergencyStop, setIsEmergencyStop] = useState(false);

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
    stateRef.current = makeState(
      generateWorkerPositions(workerCount, beltLongSide, beltShortSide),
      workerSpeeds.slice(0, workerCount),
      workerDests,
      beltLongSide,
      beltShortSide,
      bagLength,
      bagWidth,
      beltWidth,
      excelFlightEventsRef.current,
      activeSeedRef.current,
    );
    lastTsRef.current = 0;
    maxBeltSnapshotRef.current = { count: -1, snapshot: null };
    setHasPeakCapture(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
        drawSim(simCtx, displayState, now, destQuantities, effInnerLaneCapacity, effOuterLaneCapacity, clockwise, chartSeriesVisible, chartDestFilter, speedOverride?.seconds ?? null);
        if (isRecordingRef.current && offscreenCanvasRef.current && simCanvasRef.current) {
          const offCtx = offscreenCanvasRef.current.getContext('2d');
          if (offCtx) {
            offCtx.drawImage(simCanvasRef.current, 0, 0);
            drawStatsPanel(offCtx, displayState, simSpeed, SW);
          }
        }
      }

      if (Math.floor(now * 10) % 3 === 0) {
        setStats(displayState.workers.map(w => ({
          id: w.id,
          q: w.queue.length + (w.current ? 1 : 0),
          floor: w.floorQueue.length + (w.activeFloor ? 1 : 0),
          done: w.doneCount,
          floorDone: w.floorDoneCount,
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
  }, [arrivalInterval, beltSpeedMS, simSpeed, workerCount, workerSpeeds, floorDropProb, workerDests, destQuantities, pickupRate, pickupForceThreshold, effOuterLaneCapacity, effInnerLaneCapacity, floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger, workerTravelTime, beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth, clockwise, injectionRuleId, chartSeriesVisible, chartDestFilter, speedOverride]);

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
  const reset = () => {
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
  };
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
    const s = makeState(
      generateWorkerPositions(workerCount, beltLongSide, beltShortSide),
      workerSpeeds.slice(0, workerCount),
      workerDests,
      beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth,
      excelFlightEventsRef.current,
      activeSeedRef.current,
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
    setStats(snap.workers.map(w => ({
      id: w.id,
      q: w.queue.length + (w.current ? 1 : 0),
      floor: w.floorQueue.length + (w.activeFloor ? 1 : 0),
      done: w.doneCount,
      floorDone: w.floorDoneCount,
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerCount, workerSpeeds, workerDests, beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth,
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
  // idle → pushing → deploying（Vercel反映待ち・ポーリング中） → done / no_changes / error
  type DeployPhase = 'idle' | 'pushing' | 'deploying' | 'done' | 'no_changes' | 'error';
  const [deployPhase, setDeployPhase] = useState<DeployPhase>('idle');
  const [deployMessage, setDeployMessage] = useState<string>('');
  const deployPollTimerRef = useRef<number | null>(null);

  const stopDeployPolling = useCallback(() => {
    if (deployPollTimerRef.current !== null) {
      window.clearTimeout(deployPollTimerRef.current);
      deployPollTimerRef.current = null;
    }
  }, []);

  const pollDeployStatus = useCallback((sha: string) => {
    fetch(`/api/deploy/status?sha=${sha}`)
      .then(r => r.json())
      .then((data: { status: string; url?: string; message?: string }) => {
        if (data.status === 'READY') {
          setDeployPhase('done');
          setDeployMessage(data.url ? `https://${data.url}` : '');
        } else if (data.status === 'ERROR') {
          setDeployPhase('error');
          setDeployMessage('Vercelでのビルドに失敗しました');
        } else if (data.status === 'error') {
          setDeployPhase('error');
          setDeployMessage(data.message ?? '確認中にエラーが発生しました');
        } else {
          // pending / BUILDING / QUEUED 等 → 続けてポーリング
          deployPollTimerRef.current = window.setTimeout(() => pollDeployStatus(sha), 5000);
        }
      })
      .catch((e: Error) => {
        setDeployPhase('error');
        setDeployMessage(e.message);
      });
  }, []);

  const handleDeployClick = useCallback(() => {
    stopDeployPolling();
    setDeployPhase('pushing');
    setDeployMessage('');
    fetch('/api/deploy', { method: 'POST' })
      .then(r => r.json())
      .then((data: { status: string; sha?: string; message?: string }) => {
        if (data.status === 'pushed' && data.sha) {
          setDeployPhase('deploying');
          pollDeployStatus(data.sha);
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
  }, [stopDeployPolling, pollDeployStatus]);

  useEffect(() => stopDeployPolling, [stopDeployPolling]);

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
    drawSim(ctx, snap, performance.now() / 1000, destQuantities, effInnerLaneCapacity, effOuterLaneCapacity, clockwise, chartSeriesVisible, chartDestFilter, speedOverride?.seconds ?? null);
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
                disabled={deployPhase === 'pushing' || deployPhase === 'deploying'}
                title="現在のワークスペースの変更をgit pushし、Vercelへの本番反映を確認します（ローカル開発時のみ）"
                className={`px-4 py-1.5 rounded text-sm font-medium ${
                  deployPhase === 'done' ? 'bg-emerald-600'
                  : deployPhase === 'error' ? 'bg-red-600 hover:bg-red-700'
                  : deployPhase === 'pushing' || deployPhase === 'deploying' ? 'bg-gray-600 cursor-wait'
                  : 'bg-indigo-600 hover:bg-indigo-700'
                }`}
              >
                {deployPhase === 'pushing' ? '⏳ push中…'
                  : deployPhase === 'deploying' ? '⏳ 本番反映待ち…'
                  : deployPhase === 'done' ? '✅ 本番反映完了'
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
                  {PUBLIC_SIMULATION_URL} を開く
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

          {/* 一括調整スライダー（左上オーバーレイ） */}
          <div className="absolute top-2 left-2 bg-gray-900/80 rounded-lg px-3 py-2 border border-gray-600" style={{ minWidth: '180px' }}>
            <Slider
              label={`一括処理時間調整: ${workerSpeeds[0] ?? 10} 秒/個`}
              min={5} max={15} step={1}
              value={workerSpeeds[0] ?? 10}
              onChange={updateAllWorkerSpeeds}
            />
          </div>

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
            <div className="text-gray-200" style={{ fontSize: '14px' }}>処理済: {overlayStats.done} 個</div>
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
                disabled={chartSeriesVisible.flights || chartSeriesVisible.bucketSpawn}
                className={`px-3 py-1 rounded text-xs font-medium border ${(chartSeriesVisible.flights || chartSeriesVisible.bucketSpawn) ? 'bg-gray-900 border-gray-800 text-gray-700 cursor-not-allowed' : chartSeriesVisible.done ? 'bg-green-600 border-green-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
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
              min={1} max={MAX_WORKERS} step={1}
              value={workerCount}
              onChange={setWorkerCount}
            />
          </div>
          <div className="pb-2 border-b border-gray-700">
            <Slider
              label={`一括処理時間調整: ${workerSpeeds[0] ?? 10} 秒/個`}
              min={5} max={15} step={1}
              value={workerSpeeds[0] ?? 10}
              onChange={updateAllWorkerSpeeds}
            />
          </div>
          {Array.from({ length: workerCount }, (_, i) => {
            const st = stats[i];
            const q = st?.q ?? 0;
            const col = q >= 6 ? 'text-red-400' : q >= 3 ? 'text-yellow-400' : 'text-green-400';
            return (
              <div key={i}>
                <Slider
                  label={`作業${i + 1}: ${workerSpeeds[i] ?? 10} 秒/個`}
                  min={5} max={15} step={1}
                  value={workerSpeeds[i] ?? 10}
                  onChange={(v) => updateWorkerSpeed(i, v)}
                />
                <div className={`text-xs ${col} ml-2 mt-1`}>
                  待ち: {q}個 / 床仮置き: {st?.floor ?? 0}個 / 通常済: {st?.done ?? 0}個 / 床済: {st?.floorDone ?? 0}個
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
            <div>△ 黄: 2周目の荷物</div>
            <div>× 赤: 3周目以上</div>
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
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: DEST_COLORS[di] }} />
                <span className="text-xs text-gray-300 font-medium truncate">{name}</span>
              </div>
              <input
                type="number"
                min={0} max={9999}
                value={destQuantities[di]}
                onChange={e => updateDestQty(di, parseInt(e.target.value) || 0)}
                className="w-full bg-gray-800 border rounded px-2 py-1 text-sm text-gray-200 text-center focus:outline-none focus:border-blue-500"
                style={{ borderColor: DEST_COLORS[di] + '66' }}
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
              <span className="w-3 h-3 rounded-sm inline-block flex-shrink-0" style={{ backgroundColor: DEST_COLORS[di] }} />
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
                      style={{ backgroundColor: DEST_COLORS[di], color: '#fff' }}
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
