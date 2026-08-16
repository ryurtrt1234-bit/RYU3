'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';

// ── Canvas dimensions ────────────────────────────────────────
const SW = 820;
const SH = 520;
const STATS_PANEL_W = 280;

// ── 公開URL（別PCから誰でもアクセスできる本番URL） ──────────────
const PUBLIC_SIMULATION_URL = 'https://ryu3.vercel.app/simulation';

// ── Belt rectangle (defaults) ──────────────────────────────
const DEFAULT_LONG_SIDE = 30; // meters
const DEFAULT_SHORT_SIDE = 14; // meters
const PIXELS_PER_METER = 20;
const DEFAULT_BELT_WIDTH_M = 1.5; // meters
const BCX = 410, BCY = 230;
const WORKER_OFFSET = 45;

// ── 作業者人数 ────────────────────────────────────────────────
const DEFAULT_WORKER_COUNT = 4;
const MAX_WORKERS = 100;

// 作業者は「作業1」から順に、下辺→上辺→右辺→左辺の順番でラウンドロビンに配置する。
// （5人目は再び下辺、6人目は上辺…というように便数に応じて作業Noを増やしながら巡回する）
// t=0が上辺中央、t=0.25が右辺中央、t=0.5が下辺中央、t=0.75が左辺中央になる
// （beltInfoの円周パラメータ化の対称性により、ベルトの縦横比によらず常にこの位置になる）。
const WORKER_EDGE_ORDER: { center: number; lengthKey: 'W_IN' | 'H_IN' }[] = [
  { center: 0.5,  lengthKey: 'W_IN' }, // 下辺
  { center: 0.0,  lengthKey: 'W_IN' }, // 上辺
  { center: 0.25, lengthKey: 'H_IN' }, // 右辺
  { center: 0.75, lengthKey: 'H_IN' }, // 左辺
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

  // 下辺→上辺→右辺→左辺の順に1人ずつ巡回して割り当てる
  const edgeAssign: number[][] = WORKER_EDGE_ORDER.map(() => []);
  for (let i = 0; i < n; i++) edgeAssign[i % 4].push(i);

  const positions = new Array(n).fill(0);
  WORKER_EDGE_ORDER.forEach((edge, ei) => {
    const idxs = edgeAssign[ei];
    const count = idxs.length;
    if (count === 0) return;
    // コーナー付近を避けるため辺の中央80%だけを使って均等配置する
    const usableLenFrac = (edgeLength[edge.lengthKey] * 0.8) / PERIM;
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

// ── Inline chart position (inside belt center) ───────────────
const CHART_X = 205, CHART_Y = 148, CHART_W = 410, CHART_H = 164;

// ── Types ────────────────────────────────────────────────────
interface FloorBag {
  id: number;
  color: string;
  timer: number;
  maxTimer: number;
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
) {
  let remaining = dt;
  while (remaining > 1e-9) {
    const sub = Math.min(SIM_SUBSTEP, remaining);
    stepOnce(
      s, sub, arrivalInterval, beltSpeed, floorDropProb, destLimits,
      pickupRate, pickupForceThreshold, outerLaneCapacity, innerLaneCapacity,
      floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger,
      workerTravelTime, emergencyMargin, emergencyCollectInterval, clockwise, injectionRuleId,
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
          const ft = (1 / w.speed) + floorExtraTime;
          w.floorQueue.push({ id: targetBag.id, color: targetBag.color, timer: ft, maxTimer: ft });
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

            // 外側レーン上限+内側レーン上限の合計を超えたらオーバーフローとしてカウント
            const totalBeltCount = s.bags.filter(b => b.state === 'belt').length;
            if (totalBeltCount >= outerLaneCapacity + innerLaneCapacity) {
              if (s.firstOverflowTime === null) s.firstOverflowTime = s.time;
              s.totalOverflow++;
              s.nextId++;
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
        const ft = (1 / w.speed) + floorExtraTime;
        w.floorQueue.push({ id: bag.id, color: bag.color, timer: ft, maxTimer: ft });
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
        s.bags = s.bags.filter(x => x.id !== w.current!.id);
        w.current = null; w.doneCount++; s.totalDone++;
        w.travelTimer = workerTravelTime;
      }
    } else if (w.activeFloor) {
      // 床仮置き処理中 → 通常処理は開始しない
      w.activeFloor.timer -= dt;
      if (w.activeFloor.timer <= 0) {
        w.floorDoneCount++; s.totalDone++;
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
            w.current = w.queue.shift()!; w.procTimer = 1.0 / w.speed;
          }
        }
      } else if (beltSparse && w.floorQueue.length >= floorBatchThreshold && w.queue.length === 0) {
        // ベルトが半分以下かつ床仮置きが閾値以上のとき一括処理
        w.floorBatchActive = true;
        w.activeFloor = w.floorQueue.shift()!;
        w.activeFloor.timer = w.activeFloor.maxTimer;
      } else if (w.queue.length > 0) {
        // 待ちキューを処理
        w.current = w.queue.shift()!; w.procTimer = 1.0 / w.speed;
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
    s.hist.push({
      t: s.time,
      belt: s.bags.filter(b => b.state === 'belt').length,
      floor: activeFloor,
      done: s.totalDone,
      queues: s.workers.map(w => w.queue.length + (w.current ? 1 : 0)),
      spawned: s.spawnedByDest.reduce((a, b) => a + b, 0),
      flights: new Set(s.bags.filter(b => b.state === 'belt').map(b => b.destination)).size,
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
}

function drawInlineChart(ctx: CanvasRenderingContext2D, s: SimState, innerLaneCapacity: number, outerLaneCapacity: number, visible: ChartSeriesVisible) {
  const x = CHART_X, y = CHART_Y, w = CHART_W, h = CHART_H;
  const pad = { l: 52, r: 44, t: 42, b: 32 };
  const gw = w - pad.l - pad.r;
  const gh = h - pad.t - pad.b;

  ctx.fillStyle = 'rgba(10,18,36,0.88)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(75,85,99,0.5)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 8); ctx.stroke();

  const hist = s.hist;
  if (hist.length < 2) {
    ctx.fillStyle = '#4B5563'; ctx.font = '22px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('データ収集中...', x + w / 2, y + h / 2);
    return;
  }

  const maxAll = 250;

  // 常に t=0 から全履歴を表示（0m が左端に固定）
  const startT = 0;
  const endT = hist[hist.length - 1].t;
  const spanT = Math.max(endT - startT, 1);

  const px = (t: number) => x + pad.l + ((t - startT) / spanT) * gw;
  const py = (v: number) => y + pad.t + gh - (v / maxAll) * gh;

  // 右軸: 「行先便数」選択時は便数（増減あり）の最大値、それ以外は投入済み荷物量（累計・単調増加なので最終値）を基準に上限を決める
  const flightsMaxVal = hist.reduce((m, h) => Math.max(m, h.flights), 0);
  const rightMax = visible.flights ? niceCeil(Math.max(1, flightsMaxVal)) : niceCeil(hist[hist.length - 1].spawned);
  const pyRight = (v: number) => y + pad.t + gh - (v / rightMax) * gh;

  const yTicks = [0, 50, 100, 150, 200, 250];
  for (const tick of yTicks) {
    const gy = py(tick);
    ctx.strokeStyle = tick === 0 ? '#4B5563' : '#1E293B';
    ctx.lineWidth = tick === 0 ? 1.2 : 1;
    ctx.beginPath(); ctx.moveTo(x + pad.l, gy); ctx.lineTo(x + w - pad.r, gy); ctx.stroke();
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
  const innerLineY = py(Math.min(outerLaneCapacity + innerLaneCapacity, maxAll));
  if (innerLineY >= y + pad.t && innerLineY <= y + pad.t + gh) {
    ctx.save();
    ctx.strokeStyle = 'rgba(239,68,68,0.5)'; ctx.lineWidth = 2.5; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x + pad.l, innerLineY); ctx.lineTo(x + w - pad.r, innerLineY); ctx.stroke();
    ctx.fillStyle = '#EF4444'; ctx.font = '14px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`ベルト上の手荷物キャパ: ${outerLaneCapacity + innerLaneCapacity}個`, x + pad.l + 2, innerLineY - 1);
    ctx.restore();
  }

  // Y-axis labels（左軸: ベルト上の荷物。文字色は「ベルト上の荷物」の線と同じ青）
  ctx.fillStyle = visible.belt ? '#3B82F6' : '#374151'; ctx.font = '14px sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const tick of yTicks) {
    ctx.fillText(tick === 0 ? '0' : `${tick}個`, x + pad.l - 3, py(tick));
  }

  // Y-axis labels（右軸: 投入量・処理済 または 行先便数。左軸と同じ目盛位置に対応する値を表示）
  ctx.fillStyle = (visible.spawned || visible.done || visible.flights) ? '#94A3B8' : '#374151'; ctx.font = '12px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const tick of yTicks) {
    const v = Math.round((tick / maxAll) * rightMax);
    ctx.fillText(v === 0 ? '0' : `${v.toLocaleString()}`, x + w - pad.r + 4, py(tick));
  }

  // X-axis time ticks (minutes)
  const totalMinutes = endT / 60;
  let tickIntervalSec: number;
  if (totalMinutes <= 2) tickIntervalSec = 30;
  else if (totalMinutes <= 5) tickIntervalSec = 60;
  else if (totalMinutes <= 15) tickIntervalSec = 120;
  else if (totalMinutes <= 30) tickIntervalSec = 300;
  else tickIntervalSec = 600;

  ctx.font = '12px sans-serif';
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
      const mins = Math.round(xt / 60);
      ctx.fillText(xt === 0 ? '0分' : `${mins}分`, gx, y + pad.t + gh + 3);
    }
    xt += tickIntervalSec;
  }

  // Legend（1段目: 左軸の系列 / 2段目: 右軸の系列）
  const legLx = x + pad.l;
  const legLy1 = y + 6;
  const legLy2 = legLy1 + 14;
  ctx.textBaseline = 'top';
  ctx.font = '12px sans-serif';

  const legLabel1 = 'ベルト上の荷物（左軸）';
  ctx.fillStyle = visible.belt ? '#3B82F6' : '#374151'; ctx.fillRect(legLx, legLy1, 16, 8);
  ctx.fillStyle = visible.belt ? '#94A3B8' : '#4B5563'; ctx.textAlign = 'left';
  ctx.fillText(legLabel1, legLx + 20, legLy1);

  // 「行先便数」選択時は投入量・処理済の代わりに行先便数を2段目に表示する（右軸を共有できないため排他）
  const legLabel2 = visible.flights ? '行先便数（右軸）' : '投入量（右軸）';
  const legLabel2Active = visible.flights || visible.spawned;
  const legLabel2Color = visible.flights ? '#FBBF24' : '#C084FC';
  ctx.fillStyle = legLabel2Active ? legLabel2Color : '#374151'; ctx.fillRect(legLx, legLy2, 16, 8);
  ctx.fillStyle = legLabel2Active ? '#94A3B8' : '#4B5563'; ctx.textAlign = 'left';
  ctx.fillText(legLabel2, legLx + 20, legLy2);

  if (!visible.flights) {
    const legLx3 = legLx + ctx.measureText(legLabel2).width + 30;
    const legLabel3 = '処理済（右軸）';
    ctx.fillStyle = visible.done ? '#22C55E' : '#374151'; ctx.fillRect(legLx3, legLy2, 16, 8);
    ctx.fillStyle = visible.done ? '#94A3B8' : '#4B5563'; ctx.textAlign = 'left';
    ctx.fillText(legLabel3, legLx3 + 20, legLy2);
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
function drawSim(ctx: CanvasRenderingContext2D, s: SimState, now: number, destQuantities: number[], innerLaneCapacity: number, outerLaneCapacity: number, clockwise: boolean, chartSeriesVisible: ChartSeriesVisible) {
  const { workers, bags, beltW: BW, beltH: BH, beltR: BR } = s;

  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, SW, SH);

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

  // Belt direction arrows
  for (let i = 0; i < 10; i++) {
    const { pt: [ax, ay], tangent: [tx, ty] } = beltInfo(i / 10, s);
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(Math.atan2(ty, tx) + (clockwise ? 0 : Math.PI));
    ctx.fillStyle = '#6B7280'; ctx.beginPath();
    ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // Inline chart in belt center
  drawInlineChart(ctx, s, innerLaneCapacity, outerLaneCapacity, chartSeriesVisible);

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
          // 右辺・左辺: 少し下に横3個ずつの行で配置
          const pileCy = wy + 55;
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
      const labelY = isVerticalWorkerForFloor ? wy + 22 : wy + 75;
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
    const boxH = compact ? 24 : 30;
    const fontSize = compact ? 10 : 13;
    const line1 = `済 ${totalDone}/${totalAssigned}`;
    const line2 = `床 ${floorActive}個`;

    if (isVerticalWorker) {
      // 上辺・下辺: 作業者サークルの右隣に配置
      statsX = Math.min(SW - boxW / 2 - 3, wx + 30 + boxW / 2);
      statsY = Math.max(boxH / 2 + 2, Math.min(SH - boxH / 2 - 2, wy));
    } else if (nx > 0) {
      // 右辺: ベルト右外側ストリップ
      statsX = SW - boxW / 2 - 5;
      statsY = Math.max(boxH / 2 + 3, wy - 30 - boxH / 2);
    } else {
      // 左辺: ベルト左外側ストリップ
      statsX = boxW / 2 + 5;
      statsY = Math.max(boxH / 2 + 3, wy - 30 - boxH / 2);
    }

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
    ctx.fillText(line1, statsX, statsY - 6);
    ctx.fillStyle = '#FCA5A5';
    ctx.fillText(line2, statsX, statsY + 7);
  }

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
  const isRecordingRef        = useRef(false);
  const offscreenCanvasRef    = useRef<HTMLCanvasElement | null>(null);

  const [running, setRunning]             = useState(false);
  const [hasStarted, setHasStarted]       = useState(false);
  const [arrivalInterval, setArrivalInterval] = useState(2.75);
  const [beltLongSide, setBeltLongSide]   = useState(DEFAULT_LONG_SIDE);
  const [beltShortSide, setBeltShortSide] = useState(DEFAULT_SHORT_SIDE);
  const [beltWidth, setBeltWidth]         = useState(DEFAULT_BELT_WIDTH_M);
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
  const [emergencyMargin, setEmergencyMargin]             = useState(20);
  const [emergencyCollectInterval, setEmergencyCollectInterval] = useState(3);
  const [workerDests, setWorkerDests]     = useState<number[][]>(
    // 最初の4人はこれまで通り便を1つずつ担当、5人目以降は未割当（担当なし）で開始
    Array.from({ length: MAX_WORKERS }, (_, i) => (i < DEFAULT_WORKER_COUNT ? [i] : []))
  );
  const [clockwise, setClockwise] = useState(false);
  const [injectionRuleId, setInjectionRuleId] = useState<string>(INJECTION_RULES[0].id);
  const [chartSeriesVisible, setChartSeriesVisible] = useState<ChartSeriesVisible>({ belt: true, spawned: true, done: true, flights: false });
  const toggleChartSeries = (key: keyof ChartSeriesVisible) => {
    setChartSeriesVisible(prev => {
      if (key === 'flights') {
        // 行先便数は投入量・処理済と右軸を共有できないため、ONにする際は両方OFFにする
        const next = !prev.flights;
        return { ...prev, flights: next, spawned: next ? false : prev.spawned, done: next ? false : prev.done };
      }
      // 行先便数がON中は投入量・処理済を選択できない
      if (prev.flights && (key === 'spawned' || key === 'done')) return prev;
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

  const initSim = useCallback(() => {
    stateRef.current = makeState(
      generateWorkerPositions(workerCount, beltLongSide, beltShortSide),
      workerSpeeds.slice(0, workerCount),
      workerDests,
      beltLongSide,
      beltShortSide,
      bagLength,
      bagWidth,
      beltWidth,
      excelFlightEventsRef.current
    );
    lastTsRef.current = 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerCount, workerSpeeds, workerDests, beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth]);

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
        step(s, wallDt * simSpeed, arrivalInterval, circuitsPerSec, floorDropProb, destQuantities, pickupRate, pickupForceThreshold, outerLaneCapacity, innerLaneCapacity, floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger, workerTravelTime, emergencyMargin, emergencyCollectInterval, clockwise, injectionRuleId);

        // 0-5分は30秒刻み、5分以降は300秒刻みでスナップショット保存
        const snapInterval = s.time < 300 ? 30 : 300;
        const snapTime = Math.floor(s.time / snapInterval) * snapInterval;
        if (snapTime > 0 && snapTime > lastSnapIdxRef.current) {
          lastSnapIdxRef.current = snapTime;
          snapshotsRef.current.push(JSON.parse(JSON.stringify(s)));
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
          snapshotsRef.current.push(JSON.parse(JSON.stringify(s)));
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
        drawSim(simCtx, displayState, now, destQuantities, innerLaneCapacity, outerLaneCapacity, clockwise, chartSeriesVisible);
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
  }, [arrivalInterval, beltSpeedMS, simSpeed, workerCount, workerSpeeds, floorDropProb, workerDests, destQuantities, pickupRate, pickupForceThreshold, outerLaneCapacity, innerLaneCapacity, floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger, workerTravelTime, beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth, clockwise, injectionRuleId, chartSeriesVisible]);

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

    const s = makeState(
      generateWorkerPositions(workerCount, beltLongSide, beltShortSide),
      workerSpeeds.slice(0, workerCount),
      workerDests,
      beltLongSide, beltShortSide, bagLength, bagWidth, beltWidth,
      excelFlightEventsRef.current,
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
           pickupRate, pickupForceThreshold, outerLaneCapacity, innerLaneCapacity, floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger, workerTravelTime, emergencyMargin, emergencyCollectInterval, clockwise, injectionRuleId);

      // 0-5分は30秒刻み、5分以降は300秒刻みでスナップショット保存
      const snapInterval2 = s.time < 300 ? 30 : 300;
      const snapTime2 = Math.floor(s.time / snapInterval2) * snapInterval2;
      if (snapTime2 > 0 && snapTime2 > lastSnapIdxRef.current) {
        lastSnapIdxRef.current = snapTime2;
        snapshotsRef.current.push(JSON.parse(JSON.stringify(s)));
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
    snapshotsRef.current.push(JSON.parse(JSON.stringify(s)));
    const finalIdx = snapshotsRef.current.length - 1;
    scrubIndexRef.current = finalIdx;

    setSimCompleted(true);
    setSnapshotCount(snapshotsRef.current.length);
    setScrubValue(finalIdx);

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
      outerLaneCapacity, innerLaneCapacity, floorExtraTime, floorMax, floorBatchThreshold, beltFloorTrigger, workerTravelTime, emergencyMargin, emergencyCollectInterval, clockwise, injectionRuleId]);

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
        <h1 className="text-lg font-bold text-gray-100">
          空港手荷物処理能力シミュレーション
        </h1>
        <div className="flex gap-2">
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
        <div className="rounded-lg overflow-hidden border border-gray-700 relative" style={{ maxWidth: '820px' }}>
          <canvas
            ref={simCanvasRef}
            width={SW}
            height={SH}
            className="block w-full"
            style={{ aspectRatio: `${SW}/${SH}` }}
          />
          {/* 緊急停止ポップアップ（グラフ内オーバーフロー表記の真上） */}
          {isEmergencyStop && (
            <div
              className="absolute flex items-center gap-1 bg-red-700/90 text-white rounded px-2 py-0.5 border border-red-400 font-bold whitespace-nowrap"
              style={{
                bottom: `${((SH - CHART_Y) / SH * 100).toFixed(1)}%`,
                right: `${((SW - CHART_X - CHART_W + 8) / SW * 100).toFixed(1)}%`,
                fontSize: '11px',
                zIndex: 10,
              }}
            >
              🚨 緊急停止、荷物床置き中
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

        </div>

        {/* 右サイドパネル */}
        <div className="flex flex-col gap-3 min-w-[260px]">
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
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm text-gray-300 mb-2">{`シミュレーション速度: ${simSpeed}×`}</div>
              <button
                onClick={runToCompletion}
                className="mb-2 px-2 py-0.5 rounded text-xs font-medium bg-green-700 hover:bg-green-600 text-white whitespace-nowrap"
              >
                搭載終了
              </button>
            </div>
            <input
              type="range" min={0} max={SIM_SPEED_OPTIONS.length - 1} step={1}
              value={SIM_SPEED_OPTIONS.indexOf(simSpeed) === -1 ? 0 : SIM_SPEED_OPTIONS.indexOf(simSpeed)}
              onChange={e => setSimSpeed(SIM_SPEED_OPTIONS[Number(e.target.value)])}
              className="w-full accent-blue-500 h-1.5 cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
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
            <div className="flex gap-2">
              <button
                onClick={() => toggleChartSeries('belt')}
                className={`px-3 py-1 rounded text-xs font-medium border ${chartSeriesVisible.belt ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
              >
                ベルト上の荷物
              </button>
              <button
                onClick={() => toggleChartSeries('spawned')}
                disabled={chartSeriesVisible.flights}
                className={`px-3 py-1 rounded text-xs font-medium border ${chartSeriesVisible.flights ? 'bg-gray-900 border-gray-800 text-gray-700 cursor-not-allowed' : chartSeriesVisible.spawned ? 'bg-purple-600 border-purple-400 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
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
              <button
                onClick={() => toggleChartSeries('flights')}
                className={`px-3 py-1 rounded text-xs font-medium border ${chartSeriesVisible.flights ? 'bg-amber-500 border-amber-300 text-white' : 'bg-gray-800 border-gray-600 text-gray-500'}`}
              >
                行先便数
              </button>
            </div>
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
          <Slider label={`短辺長さ: ${beltShortSide}m`}                      min={5}  max={25}  step={1}     value={beltShortSide}  onChange={setBeltShortSide} />
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
          <Slider label={`外側レーン上限: ${outerLaneCapacity} 個`}           min={10}  max={200}  step={5}     value={outerLaneCapacity} onChange={setOuterLaneCapacity} />
          <Slider label={`内側レーン上限: ${innerLaneCapacity} 個`}           min={10}  max={200}  step={5}     value={innerLaneCapacity} onChange={setInnerLaneCapacity} />
          <Slider label={`緊急停止荷物数（ベルト上）: ${outerLaneCapacity + innerLaneCapacity}個 - ${emergencyMargin} 個`}           min={0}   max={50}   step={5}     value={emergencyMargin}         onChange={setEmergencyMargin} />
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
function Slider({ label, min, max, step, value, onChange }: {
  label: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="text-xs text-gray-300 mb-1">{label}</div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-blue-500 h-1.5 cursor-pointer"
      />
    </div>
  );
}
