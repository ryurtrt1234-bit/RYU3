'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';

// ── Canvas dimensions ────────────────────────────────────────
const SW = 820;   // simulation canvas width
const SH = 480;   // simulation canvas height
const CW = 820;   // chart canvas width
const CH = 110;   // chart canvas height

// ── Belt ellipse ─────────────────────────────────────────────
const BX = 395, BY = 215;   // center
const BRX = 305, BRY = 155; // semi-axes
const BELT_W = 26;          // track width in px
const WORKER_OFFSET = 62;   // px outward from belt for worker icon

// ── Bag sizing ───────────────────────────────────────────────
const BAG_W = 14, BAG_H = 10;

// ── Colors ───────────────────────────────────────────────────
const BAG_PALETTE = [
  '#3B82F6','#F59E0B','#10B981','#EF4444',
  '#8B5CF6','#EC4899','#06B6D4','#84CC16',
];

// ── Types ────────────────────────────────────────────────────
interface Bag {
  id: number;
  pos: number;          // 0-1 belt position
  color: string;
  circuits: number;     // full loops completed
  rejects: number;      // times denied by a worker
  state: 'belt' | 'queued' | 'floor';
  workerId: number | null;
}

interface WorkerDef {
  id: number;
  pos: number;          // 0-1 belt position
  speed: number;        // bags/second
  maxQueue: number;
  queue: Bag[];
  current: Bag | null;
  procTimer: number;
  floorBags: number;
  doneCount: number;
}

interface HistPt {
  t: number;
  belt: number;
  floor: number;
  done: number;
  queues: number[];
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
  lastHist: number;
}

// ── Geometry helpers ─────────────────────────────────────────
function beltPt(t: number): [number, number] {
  const a = t * Math.PI * 2 - Math.PI / 2;
  return [BX + BRX * Math.cos(a), BY + BRY * Math.sin(a)];
}

function beltNormal(t: number): [number, number] {
  const a = t * Math.PI * 2 - Math.PI / 2;
  // Outward normal for ellipse: (cos(a)/BRX, sin(a)/BRY) normalized
  const nx = Math.cos(a) / BRX;
  const ny = Math.sin(a) / BRY;
  const len = Math.sqrt(nx * nx + ny * ny);
  return [nx / len, ny / len];
}

function beltTangent(t: number): [number, number] {
  const a = t * Math.PI * 2 - Math.PI / 2;
  const tx = -BRX * Math.sin(a);
  const ty =  BRY * Math.cos(a);
  const len = Math.sqrt(tx * tx + ty * ty);
  return [tx / len, ty / len];
}

function workerXY(w: WorkerDef): [number, number] {
  const [bx, by] = beltPt(w.pos);
  const [nx, ny] = beltNormal(w.pos);
  return [bx + nx * WORKER_OFFSET, by + ny * WORKER_OFFSET];
}

// ── Simulation init ──────────────────────────────────────────
function makeState(workerPositions: number[], workerSpeeds: number[], maxQ: number): SimState {
  const workers: WorkerDef[] = workerPositions.map((pos, i) => ({
    id: i,
    pos,
    speed: workerSpeeds[i],
    maxQueue: maxQ,
    queue: [],
    current: null,
    procTimer: 0,
    floorBags: 0,
    doneCount: 0,
  }));
  return {
    bags: [],
    workers,
    time: 0,
    nextSpawn: 0,
    nextId: 0,
    hist: [],
    totalDone: 0,
    totalFloor: 0,
    lastHist: -1,
  };
}

// ── Simulation step ──────────────────────────────────────────
function step(
  s: SimState,
  dt: number,
  arrivalRate: number,  // bags/sec
  beltSpeed: number,    // circuits/sec
) {
  s.time += dt;

  // Spawn bags
  while (s.time >= s.nextSpawn) {
    s.bags.push({
      id: s.nextId++,
      pos: 0.01,
      color: BAG_PALETTE[s.nextId % BAG_PALETTE.length],
      circuits: 0,
      rejects: 0,
      state: 'belt',
      workerId: null,
    });
    s.nextSpawn += (1 / arrivalRate) * (0.6 + Math.random() * 0.8);
  }

  // Move belt bags & check worker claims
  for (const bag of s.bags) {
    if (bag.state !== 'belt') continue;

    const prevPos = bag.pos;
    bag.pos += beltSpeed * dt;
    if (bag.pos >= 1.0) {
      bag.pos -= 1.0;
      bag.circuits++;
    }

    // Did the bag pass any worker position?
    for (const w of s.workers) {
      const wPos = w.pos;
      let crossed = false;
      if (prevPos <= bag.pos) {
        crossed = prevPos <= wPos && wPos < bag.pos;
      } else {
        // wrapped around 0
        crossed = wPos >= prevPos || wPos < bag.pos;
      }
      if (!crossed) continue;

      // Try to claim
      if (w.queue.length < w.maxQueue) {
        bag.state = 'queued';
        bag.workerId = w.id;
        bag.pos = w.pos;
        w.queue.push(bag);
        break;
      } else {
        bag.rejects++;
        // After enough rejects, floor it at the fullest worker near current pos
        if (bag.rejects >= 3 || bag.circuits >= 3) {
          bag.state = 'floor';
          // assign floor to worker with longest queue
          const busiest = s.workers.reduce((a, b) =>
            (a.queue.length + (a.current ? 1 : 0)) >= (b.queue.length + (b.current ? 1 : 0)) ? a : b
          );
          bag.workerId = busiest.id;
          busiest.floorBags++;
          s.totalFloor++;
          break;
        }
      }
    }
  }

  // Worker processing
  for (const w of s.workers) {
    if (!w.current && w.queue.length > 0) {
      w.current = w.queue.shift()!;
      w.procTimer = 1.0 / w.speed;
    }
    if (w.current) {
      w.procTimer -= dt;
      if (w.procTimer <= 0) {
        // done
        const b = w.current;
        s.bags = s.bags.filter(x => x.id !== b.id);
        w.current = null;
        w.doneCount++;
        s.totalDone++;
      }
    }
  }

  // Record history every second
  if (s.time - s.lastHist >= 1) {
    s.lastHist = s.time;
    const beltCount = s.bags.filter(b => b.state === 'belt').length;
    const floorCount = s.bags.filter(b => b.state === 'floor').length;
    s.hist.push({
      t: s.time,
      belt: beltCount,
      floor: floorCount,
      done: s.totalDone,
      queues: s.workers.map(w => w.queue.length + (w.current ? 1 : 0)),
    });
    if (s.hist.length > 90) s.hist.shift();
  }
}

// ── Queue color ──────────────────────────────────────────────
function queueColor(qLen: number, maxQ: number): string {
  const ratio = qLen / maxQ;
  if (ratio < 0.4) return '#22C55E';   // green
  if (ratio < 0.7) return '#EAB308';   // yellow
  return '#EF4444';                     // red
}

// ── Draw simulation canvas ───────────────────────────────────
function drawSim(
  ctx: CanvasRenderingContext2D,
  s: SimState,
  now: number,
) {
  const { workers, bags } = s;

  // Background
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, SW, SH);

  // Belt track shadow
  ctx.save();
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.ellipse(BX, BY, BRX, BRY, 0, 0, Math.PI * 2);
  ctx.strokeStyle = '#1F2937';
  ctx.lineWidth = BELT_W + 8;
  ctx.stroke();
  ctx.restore();

  // Belt surface
  ctx.beginPath();
  ctx.ellipse(BX, BY, BRX, BRY, 0, 0, Math.PI * 2);
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = BELT_W;
  ctx.stroke();

  // Belt center line (dashed)
  ctx.beginPath();
  ctx.ellipse(BX, BY, BRX, BRY, 0, 0, Math.PI * 2);
  ctx.strokeStyle = '#4B5563';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 8]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Belt arrows (direction indicators)
  for (let i = 0; i < 8; i++) {
    const t = i / 8;
    const [ax, ay] = beltPt(t);
    const [tx, ty] = beltTangent(t);
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(Math.atan2(ty, tx));
    ctx.fillStyle = '#6B7280';
    ctx.beginPath();
    ctx.moveTo(6, 0);
    ctx.lineTo(-4, -4);
    ctx.lineTo(-4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Injection point
  {
    const [ix, iy] = beltPt(0);
    ctx.save();
    ctx.shadowColor = '#10B981';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(ix, iy, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#10B981';
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#D1FAE5';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('荷物投入', ix, iy - 18);
  }

  // Find bottleneck worker
  const bottleneck = workers.reduce((a, b) => {
    const qa = a.queue.length + (a.current ? 1 : 0);
    const qb = b.queue.length + (b.current ? 1 : 0);
    return qa >= qb ? a : b;
  });
  const bottleneckQueue = bottleneck.queue.length + (bottleneck.current ? 1 : 0);

  // Draw workers
  for (const w of workers) {
    const [wx, wy] = workerXY(w);
    const totalQ = w.queue.length + (w.current ? 1 : 0);
    const col = queueColor(totalQ, w.maxQueue);
    const isBottleneck = w === bottleneck && bottleneckQueue >= 3;

    // Bottleneck pulse ring
    if (isBottleneck) {
      const pulse = 0.6 + 0.4 * Math.abs(Math.sin(now * 3));
      ctx.save();
      ctx.shadowColor = '#EF4444';
      ctx.shadowBlur = 20 * pulse;
      ctx.beginPath();
      ctx.arc(wx, wy, 28 * pulse * 0.8 + 12, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(239,68,68,${pulse * 0.9})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }

    // Queue stack (bags stacked outward from belt)
    const [nx, ny] = beltNormal(w.pos);
    const queueBags = [...w.queue];
    if (w.current) queueBags.unshift(w.current);
    for (let qi = 0; qi < queueBags.length; qi++) {
      const b = queueBags[qi];
      const stackX = wx + nx * (20 + qi * 12);
      const stackY = wy + ny * (20 + qi * 12);
      ctx.save();
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 4;
      ctx.fillStyle = qi === 0 && w.current ? b.color : b.color + 'CC';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 0.5;
      const ang = Math.atan2(ny, nx);
      ctx.translate(stackX, stackY);
      ctx.rotate(ang);
      ctx.fillRect(-BAG_W / 2, -BAG_H / 2, BAG_W, BAG_H);
      ctx.strokeRect(-BAG_W / 2, -BAG_H / 2, BAG_W, BAG_H);
      ctx.restore();
    }

    // Processing progress arc
    if (w.current) {
      const progress = 1 - w.procTimer * w.speed;
      ctx.beginPath();
      ctx.arc(wx, wy, 22, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.strokeStyle = '#60A5FA';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Worker circle
    ctx.save();
    ctx.shadowColor = col;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(wx, wy, 18, 0, Math.PI * 2);
    ctx.fillStyle = col + '33';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();

    // Worker label
    ctx.fillStyle = '#F9FAFB';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`W${w.id + 1}`, wx, wy);

    // Queue count badge
    if (totalQ > 0) {
      const badgeX = wx + 16, badgeY = wy - 16;
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, 9, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(totalQ), badgeX, badgeY);
    }

    // Floor bags indicator
    if (w.floorBags > 0) {
      const pileCx = wx - nx * 30;
      const pileCy = wy - ny * 30;
      const spread = Math.min(w.floorBags, 6);
      for (let fi = 0; fi < spread; fi++) {
        const ox = (fi % 3) * 10 - 10;
        const oy = Math.floor(fi / 3) * 8 - 4;
        ctx.fillStyle = '#78716C';
        ctx.strokeStyle = '#57534E';
        ctx.lineWidth = 0.5;
        ctx.fillRect(pileCx + ox - 5, pileCy + oy - 4, 10, 7);
        ctx.strokeRect(pileCx + ox - 5, pileCy + oy - 4, 10, 7);
      }
      ctx.fillStyle = '#FEF3C7';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`地面:${w.floorBags}`, pileCx, pileCy + 12);
    }

    // Bottleneck label
    if (isBottleneck) {
      ctx.save();
      ctx.fillStyle = '#FEF2F2';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      const bly = wy + 32;
      ctx.shadowColor = '#EF4444';
      ctx.shadowBlur = 8;
      ctx.fillText('⚠ 渋滞', wx, bly);
      ctx.restore();
    }
  }

  // Draw bags on belt
  for (const bag of bags) {
    if (bag.state !== 'belt') continue;
    const [bx2, by2] = beltPt(bag.pos);
    const [tx, ty] = beltTangent(bag.pos);

    ctx.save();
    ctx.translate(bx2, by2);
    ctx.rotate(Math.atan2(ty, tx));

    // Stale bags (circulated many times) get a warning tint
    const alpha = bag.circuits === 0 ? 'FF' : bag.circuits === 1 ? 'CC' : '99';
    ctx.fillStyle = bag.color + alpha;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.8;
    ctx.shadowColor = bag.color;
    ctx.shadowBlur = 5;
    ctx.fillRect(-BAG_W / 2, -BAG_H / 2, BAG_W, BAG_H);
    ctx.strokeRect(-BAG_W / 2, -BAG_H / 2, BAG_W, BAG_H);

    // Circuit count dot for circulating bags
    if (bag.circuits > 0) {
      ctx.fillStyle = bag.circuits >= 3 ? '#EF4444' : '#EAB308';
      ctx.beginPath();
      ctx.arc(BAG_W / 2 - 2, -BAG_H / 2 + 2, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // Stats overlay (top-left)
  ctx.fillStyle = 'rgba(17,24,39,0.85)';
  ctx.beginPath();
  ctx.roundRect(12, 10, 170, 80, 8);
  ctx.fill();
  ctx.fillStyle = '#E5E7EB';
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`時刻:  ${s.time.toFixed(1)} s`, 22, 18);
  ctx.fillText(`ベルト: ${bags.filter(b => b.state === 'belt').length} 個`, 22, 34);
  ctx.fillText(`処理済: ${s.totalDone} 個`, 22, 50);
  ctx.fillText(`地面:  ${s.totalFloor} 個`, 22, 66);

  // Legend
  ctx.fillStyle = 'rgba(17,24,39,0.85)';
  ctx.beginPath();
  ctx.roundRect(SW - 148, 10, 136, 62, 8);
  ctx.fill();
  const legendItems = [
    { color: '#22C55E', label: '余裕あり' },
    { color: '#EAB308', label: '混雑中' },
    { color: '#EF4444', label: '渋滞！' },
  ];
  legendItems.forEach(({ color, label }, i) => {
    ctx.beginPath();
    ctx.arc(SW - 132, 24 + i * 16, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#D1D5DB';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, SW - 122, 24 + i * 16);
  });

  // Belt label
  ctx.fillStyle = '#6B7280';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ベルトコンベア', BX, BY);
}

// ── Draw chart canvas ────────────────────────────────────────
function drawChart(ctx: CanvasRenderingContext2D, s: SimState) {
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(0, 0, CW, CH);

  const hist = s.hist;
  if (hist.length < 2) return;

  const pad = { l: 45, r: 10, t: 14, b: 24 };
  const gw = CW - pad.l - pad.r;
  const gh = CH - pad.t - pad.b;

  // Grid
  ctx.strokeStyle = '#1E293B';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = pad.t + (gh * g) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(CW - pad.r, y);
    ctx.stroke();
  }

  const maxBelt = Math.max(...hist.map(h => h.belt), 1);
  const maxAll = Math.max(maxBelt, ...hist.map(h => h.floor), 5);
  const maxDone = Math.max(...hist.map(h => h.done), 1);

  const px = (i: number) => pad.l + (i / (hist.length - 1)) * gw;
  const pyCount = (v: number) => pad.t + gh - (v / maxAll) * gh;
  const lines: { key: keyof HistPt; color: string; yFn: (v: number) => number }[] = [
    { key: 'belt',  color: '#3B82F6', yFn: pyCount },
    { key: 'floor', color: '#EF4444', yFn: pyCount },
  ];

  void maxDone; // reserved for future done-count axis

  for (const { key, color, yFn } of lines) {
    ctx.beginPath();
    hist.forEach((h, i) => {
      const v = h[key] as number;
      const x = px(i), y = yFn(v);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  // Per-worker queue lines (faint)
  const wColors = ['#60A5FA','#34D399','#FBBF24','#F87171','#A78BFA','#F472B6'];
  const numW = s.workers.length;
  if (hist[0]?.queues) {
    for (let wi = 0; wi < numW; wi++) {
      ctx.beginPath();
      hist.forEach((h, i) => {
        if (!h.queues) return;
        const v = h.queues[wi] ?? 0;
        const x = px(i), y = pyCount(v);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = wColors[wi % wColors.length] + '88';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  // Y axis label
  ctx.fillStyle = '#64748B';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const v = Math.round((maxAll * (4 - g)) / 4);
    ctx.fillText(String(v), pad.l - 4, pad.t + (gh * g) / 4);
  }

  // X axis time labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < hist.length; i += Math.max(1, Math.floor(hist.length / 6))) {
    ctx.fillText(`${hist[i].t.toFixed(0)}s`, px(i), pad.t + gh + 4);
  }

  // Legend
  const legItems = [
    { color: '#3B82F6', label: 'ベルト' },
    { color: '#EF4444', label: '地面' },
  ];
  s.workers.forEach((_w, i) => {
    legItems.push({ color: wColors[i % wColors.length], label: `W${i + 1}待ち` });
  });
  let lx = pad.l;
  for (const { color, label } of legItems) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, 2, 16, 5);
    ctx.fillStyle = '#94A3B8';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, lx + 18, 1);
    lx += ctx.measureText(label).width + 32;
  }
}

// ── Main component ───────────────────────────────────────────
export default function BaggageSimulation() {
  const simCanvasRef  = useRef<HTMLCanvasElement>(null);
  const chartCanvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef  = useRef<SimState | null>(null);
  const lastTsRef = useRef<number>(0);
  const runningRef = useRef(true);

  // Config state (drives UI)
  const [running, setRunning] = useState(true);
  const [arrivalRate, setArrivalRate] = useState(0.5);  // bags/sec
  const [beltSpeed, setBeltSpeed]   = useState(0.06);   // circuits/sec
  const [simSpeed, setSimSpeed]     = useState(1);
  const [numWorkers, setNumWorkers] = useState(4);
  const [maxQueue, setMaxQueue]     = useState(8);
  const [workerSpeeds, setWorkerSpeeds] = useState<number[]>([0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
  const [stats, setStats] = useState<{ id: number; q: number; floor: number; done: number }[]>([]);

  // Rebuild sim state only when worker count changes
  const initSim = useCallback((nw?: number) => {
    const count = nw ?? numWorkers;
    const positions = Array.from({ length: count }, (_, i) =>
      (i / count + 0.1) % 1
    );
    const speeds = workerSpeeds.slice(0, count);
    while (speeds.length < count) speeds.push(0.3);
    stateRef.current = makeState(positions, speeds, maxQueue);
    lastTsRef.current = 0;
  }, [numWorkers, workerSpeeds, maxQueue]);

  useEffect(() => {
    initSim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numWorkers]);

  // Animation loop
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
        // Apply worker speeds from current state
        s.workers.forEach((w, i) => {
          w.speed = workerSpeeds[i] ?? 0.3;
          w.maxQueue = maxQueue;
        });
        step(s, wallDt * simSpeed, arrivalRate, beltSpeed);
      }

      const simCtx = simCanvasRef.current?.getContext('2d');
      if (simCtx) drawSim(simCtx, s, now);

      const chartCtx = chartCanvasRef.current?.getContext('2d');
      if (chartCtx) drawChart(chartCtx, s);

      // Update React stats every ~10 frames
      if (Math.floor(now * 10) % 3 === 0) {
        setStats(s.workers.map(w => ({
          id: w.id,
          q: w.queue.length + (w.current ? 1 : 0),
          floor: w.floorBags,
          done: w.doneCount,
        })));
      }
    };

    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [arrivalRate, beltSpeed, simSpeed, workerSpeeds, maxQueue]);

  const toggleRunning = () => {
    runningRef.current = !runningRef.current;
    setRunning(r => !r);
  };

  const reset = () => {
    initSim();
  };

  const updateWorkerSpeed = (i: number, v: number) => {
    setWorkerSpeeds(prev => {
      const next = [...prev];
      next[i] = v;
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3 p-4 bg-gray-950 min-h-screen text-gray-100">
      <h1 className="text-lg font-bold text-gray-100">
        空港 手荷物ベルトコンベア シミュレーション
      </h1>

      {/* Simulation canvas */}
      <div className="rounded-lg overflow-hidden border border-gray-700">
        <canvas
          ref={simCanvasRef}
          width={SW}
          height={SH}
          className="block w-full"
          style={{ aspectRatio: `${SW}/${SH}` }}
        />
      </div>

      {/* Time-series chart */}
      <div className="rounded-lg overflow-hidden border border-gray-700">
        <canvas
          ref={chartCanvasRef}
          width={CW}
          height={CH}
          className="block w-full"
          style={{ aspectRatio: `${CW}/${CH}` }}
        />
      </div>

      {/* Controls + Stats row */}
      <div className="flex gap-4 flex-wrap">

        {/* Global controls */}
        <div className="flex-1 min-w-60 bg-gray-900 rounded-lg p-4 border border-gray-700">
          <div className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">
            全体設定
          </div>

          {/* Play/Pause/Reset */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={toggleRunning}
              className={`px-4 py-1.5 rounded text-sm font-medium ${
                running ? 'bg-yellow-600 hover:bg-yellow-700' : 'bg-green-600 hover:bg-green-700'
              }`}
            >
              {running ? '⏸ 一時停止' : '▶ 再開'}
            </button>
            <button
              onClick={reset}
              className="px-4 py-1.5 rounded text-sm font-medium bg-gray-700 hover:bg-gray-600"
            >
              ↺ リセット
            </button>
          </div>

          <Slider
            label={`到着レート: ${arrivalRate.toFixed(2)} 個/秒`}
            min={0.1} max={2.0} step={0.05}
            value={arrivalRate}
            onChange={setArrivalRate}
          />
          <Slider
            label={`ベルト速度: ${beltSpeed.toFixed(3)} 周/秒`}
            min={0.01} max={0.15} step={0.005}
            value={beltSpeed}
            onChange={setBeltSpeed}
          />
          <Slider
            label={`シミュレーション速度: ${simSpeed}×`}
            min={1} max={8} step={1}
            value={simSpeed}
            onChange={setSimSpeed}
          />
          <Slider
            label={`最大待ち数: ${maxQueue} 個`}
            min={2} max={20} step={1}
            value={maxQueue}
            onChange={setMaxQueue}
          />
          <Slider
            label={`作業者数: ${numWorkers} 人`}
            min={1} max={6} step={1}
            value={numWorkers}
            onChange={(v) => { setNumWorkers(v); }}
          />
        </div>

        {/* Per-worker speeds */}
        <div className="flex-1 min-w-60 bg-gray-900 rounded-lg p-4 border border-gray-700">
          <div className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">
            作業者別処理速度
          </div>
          {Array.from({ length: numWorkers }, (_, i) => {
            const st = stats[i];
            const q = st?.q ?? 0;
            const col = q >= maxQueue * 0.7 ? 'text-red-400' : q >= maxQueue * 0.4 ? 'text-yellow-400' : 'text-green-400';
            return (
              <div key={i} className="mb-2">
                <Slider
                  label={`W${i + 1}: ${(workerSpeeds[i] ?? 0.3).toFixed(2)} 個/秒`}
                  min={0.05} max={1.0} step={0.05}
                  value={workerSpeeds[i] ?? 0.3}
                  onChange={(v) => updateWorkerSpeed(i, v)}
                />
                <div className={`text-xs ${col} ml-2`}>
                  待ち: {q}個 / 地面: {st?.floor ?? 0}個 / 処理済: {st?.done ?? 0}個
                </div>
              </div>
            );
          })}
        </div>

        {/* Per-worker queue bar chart */}
        <div className="flex-1 min-w-48 bg-gray-900 rounded-lg p-4 border border-gray-700">
          <div className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wide">
            待ち行列比較
          </div>
          {stats.slice(0, numWorkers).map((st, i) => {
            const ratio = Math.min(st.q / maxQueue, 1);
            const col = ratio >= 0.7 ? 'bg-red-500' : ratio >= 0.4 ? 'bg-yellow-500' : 'bg-green-500';
            const isMax = st.q === Math.max(...stats.slice(0, numWorkers).map(s => s.q));
            return (
              <div key={i} className="mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs w-8 text-gray-400">W{i + 1}</span>
                  <div className="flex-1 bg-gray-800 rounded h-4 relative overflow-hidden">
                    <div
                      className={`h-full rounded transition-all duration-200 ${col}`}
                      style={{ width: `${ratio * 100}%` }}
                    />
                  </div>
                  <span className={`text-xs w-6 text-right ${isMax && st.q > 0 ? 'text-red-400 font-bold' : 'text-gray-400'}`}>
                    {st.q}
                  </span>
                  {isMax && st.q >= 3 && (
                    <span className="text-red-400 text-xs">⚠</span>
                  )}
                </div>
              </div>
            );
          })}

          <div className="mt-3 pt-3 border-t border-gray-700 text-xs text-gray-500 space-y-1">
            <div>● 黄丸: 2周目の荷物</div>
            <div>● 赤丸: 3周目以上</div>
            <div>● 地面: 処理不能で足元へ</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Reusable slider ──────────────────────────────────────────
function Slider({
  label, min, max, step, value, onChange,
}: {
  label: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-3">
      <div className="text-xs text-gray-300 mb-1">{label}</div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full accent-blue-500 h-1.5 cursor-pointer"
      />
    </div>
  );
}
