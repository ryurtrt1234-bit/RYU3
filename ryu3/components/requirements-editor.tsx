'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

export const SIM_CONFIG_STORAGE_KEY = 'ryu3-simulation-config';

export interface ScenarioConfig {
  scenarioName: string;
  airport: string;
  operationHours: string;
  totalBagsPerHour: number;
  workerCount: number;
  arrivalInterval: number;
  beltLongSide: number;
  beltShortSide: number;
  beltWidth: number;
  bagLength: number;
  bagWidth: number;
  beltSpeedMS: number;
  floorDropProb: number;
  pickupRate: number;
  workerTravelTime: number;
  outerLaneCapacity: number;
  innerLaneCapacity: number;
  emergencyMargin: number;
  emergencyCollectInterval: number;
  clockwise: boolean;
  notes: string;
}

export const DEFAULT_SCENARIO_CONFIG: ScenarioConfig = {
  scenarioName: '羽田発国内線A-1',
  airport: '東京国際空港',
  operationHours: '07:00-11:00',
  totalBagsPerHour: 2400,
  workerCount: 4,
  arrivalInterval: 2.75,
  beltLongSide: 30,
  beltShortSide: 14,
  beltWidth: 1.5,
  bagLength: 0.65,
  bagWidth: 0.43,
  beltSpeedMS: 0.4,
  floorDropProb: 0.3,
  pickupRate: 0.5,
  workerTravelTime: 2,
  outerLaneCapacity: 100,
  innerLaneCapacity: 100,
  emergencyMargin: 20,
  emergencyCollectInterval: 3,
  clockwise: false,
  notes: '朝ラッシュ時の国際線接続手荷物。荷物の偏りと床置きを重視して評価する。',
};

export default function RequirementsEditor() {
  const [form, setForm] = useState<ScenarioConfig>(DEFAULT_SCENARIO_CONFIG);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIM_CONFIG_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<ScenarioConfig>;
      setForm({ ...DEFAULT_SCENARIO_CONFIG, ...parsed });
    } catch {
      // 既存設定がない/壊れている場合はデフォルト値を維持
    }
  }, []);

  const updateField = <K extends keyof ScenarioConfig>(key: K, value: ScenarioConfig[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const saveConfig = () => {
    window.localStorage.setItem(SIM_CONFIG_STORAGE_KEY, JSON.stringify(form));
    setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-400">RYU3</p>
            <h1 className="mt-2 text-3xl font-bold text-white">要件入力・編集画面</h1>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={saveConfig}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500"
            >
              保存
            </button>
            <Link
              href="/simulation"
              className="rounded-md border border-slate-600 bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-700"
            >
              シミュレーションへ
            </Link>
          </div>
        </div>

        <div className="mb-6 rounded-xl border border-slate-700 bg-slate-900/80 p-4 text-sm text-slate-300">
          <div className="flex items-center justify-between gap-4">
            <span>現在の要件状態</span>
            <span className="text-sky-300">{savedAt ? `保存時刻: ${savedAt}` : '未保存'}</span>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
          <section className="rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-lg shadow-slate-950/30">
            <h2 className="mb-4 text-lg font-semibold text-slate-200">基本要件</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="シナリオ名">
                <input
                  value={form.scenarioName}
                  onChange={(e) => updateField('scenarioName', e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="空港名">
                <input
                  value={form.airport}
                  onChange={(e) => updateField('airport', e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="稼働時間帯">
                <input
                  value={form.operationHours}
                  onChange={(e) => updateField('operationHours', e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="時間当たり投入量（件）">
                <input
                  type="number"
                  min={0}
                  value={form.totalBagsPerHour}
                  onChange={(e) => updateField('totalBagsPerHour', Number(e.target.value) || 0)}
                  className="input"
                />
              </Field>
            </div>

            <div className="mt-6 rounded-xl border border-slate-700 bg-slate-950/60 p-4">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">運用条件</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="作業者人数">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={form.workerCount}
                    onChange={(e) => updateField('workerCount', Number(e.target.value) || 1)}
                    className="input"
                  />
                </Field>
                <Field label="ベルト速度 (m/s)">
                  <input
                    type="number"
                    min={0.1}
                    max={1.5}
                    step={0.05}
                    value={form.beltSpeedMS}
                    onChange={(e) => updateField('beltSpeedMS', Number(e.target.value) || 0.1)}
                    className="input"
                  />
                </Field>
                <Field label="投入間隔 (秒/個)">
                  <input
                    type="number"
                    min={0.25}
                    max={10}
                    step={0.25}
                    value={form.arrivalInterval}
                    onChange={(e) => updateField('arrivalInterval', Number(e.target.value) || 0.25)}
                    className="input"
                  />
                </Field>
                <Field label="ピックアップ率 (%)">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(form.pickupRate * 100)}
                    onChange={(e) => updateField('pickupRate', Math.min(1, Math.max(0, Number(e.target.value || 0) / 100)))}
                    className="input"
                  />
                </Field>
                <Field label="長辺 (m)">
                  <input
                    type="number"
                    min={10}
                    max={40}
                    value={form.beltLongSide}
                    onChange={(e) => updateField('beltLongSide', Number(e.target.value) || 10)}
                    className="input"
                  />
                </Field>
                <Field label="短辺 (m)">
                  <input
                    type="number"
                    min={5}
                    max={25}
                    value={form.beltShortSide}
                    onChange={(e) => updateField('beltShortSide', Number(e.target.value) || 5)}
                    className="input"
                  />
                </Field>
                <Field label="ベルト幅 (m)">
                  <input
                    type="number"
                    min={0.5}
                    max={3}
                    step={0.1}
                    value={form.beltWidth}
                    onChange={(e) => updateField('beltWidth', Number(e.target.value) || 0.5)}
                    className="input"
                  />
                </Field>
                <Field label="荷物長さ (m)">
                  <input
                    type="number"
                    min={0.3}
                    max={1.2}
                    step={0.01}
                    value={form.bagLength}
                    onChange={(e) => updateField('bagLength', Number(e.target.value) || 0.3)}
                    className="input"
                  />
                </Field>
                <Field label="荷物幅 (m)">
                  <input
                    type="number"
                    min={0.2}
                    max={0.8}
                    step={0.01}
                    value={form.bagWidth}
                    onChange={(e) => updateField('bagWidth', Number(e.target.value) || 0.2)}
                    className="input"
                  />
                </Field>
                <Field label="外側レーン上限">
                  <input
                    type="number"
                    min={10}
                    max={200}
                    step={5}
                    value={form.outerLaneCapacity}
                    onChange={(e) => updateField('outerLaneCapacity', Number(e.target.value) || 10)}
                    className="input"
                  />
                </Field>
                <Field label="内側レーン上限">
                  <input
                    type="number"
                    min={10}
                    max={200}
                    step={5}
                    value={form.innerLaneCapacity}
                    onChange={(e) => updateField('innerLaneCapacity', Number(e.target.value) || 10)}
                    className="input"
                  />
                </Field>
                <Field label="緊急停止マージン">
                  <input
                    type="number"
                    min={0}
                    max={50}
                    step={5}
                    value={form.emergencyMargin}
                    onChange={(e) => updateField('emergencyMargin', Number(e.target.value) || 0)}
                    className="input"
                  />
                </Field>
                <Field label="床置き追加時間 (秒)">
                  <input
                    type="number"
                    min={0}
                    max={30}
                    value={form.emergencyCollectInterval}
                    onChange={(e) => updateField('emergencyCollectInterval', Number(e.target.value) || 0)}
                    className="input"
                  />
                </Field>
              </div>
            </div>
          </section>

          <aside className="space-y-6">
            <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
              <h2 className="mb-4 text-lg font-semibold text-slate-200">要件サマリー</h2>
              <dl className="space-y-3 text-sm text-slate-300">
                <SummaryRow label="シナリオ" value={form.scenarioName} />
                <SummaryRow label="空港" value={form.airport} />
                <SummaryRow label="時間帯" value={form.operationHours} />
                <SummaryRow label="投入量" value={`${form.totalBagsPerHour.toLocaleString()} 件/時`} />
                <SummaryRow label="作業者" value={`${form.workerCount} 人`} />
                <SummaryRow label="ベルト" value={`${form.beltLongSide} × ${form.beltShortSide} m`} />
                <SummaryRow label="ベルト速度" value={`${form.beltSpeedMS.toFixed(2)} m/s`} />
                <SummaryRow label="回転方向" value={form.clockwise ? '時計回り' : '反時計回り'} />
              </dl>
            </div>

            <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5">
              <h2 className="mb-3 text-lg font-semibold text-slate-200">メモ</h2>
              <textarea
                value={form.notes}
                onChange={(e) => updateField('notes', e.target.value)}
                rows={8}
                className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-sky-500"
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={form.clockwise}
                    onChange={(e) => updateField('clockwise', e.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-sky-500 focus:ring-sky-500"
                  />
                  時計回り
                </label>
                <button
                  type="button"
                  onClick={saveConfig}
                  className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
                >
                  現在値を保存
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>

      <style jsx>{`
        .input {
          width: 100%;
          border-radius: 0.75rem;
          border: 1px solid rgb(71 85 105);
          background: rgb(2 6 23);
          padding: 0.7rem 0.8rem;
          color: rgb(226 232 240);
          outline: none;
        }
        .input:focus {
          border-color: rgb(14 165 233);
          box-shadow: 0 0 0 1px rgb(14 165 233);
        }
      `}</style>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm text-slate-300">
      <span className="mb-2 block text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      {children}
    </label>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-800 pb-2 last:border-b-0 last:pb-0">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right text-slate-200">{value}</dd>
    </div>
  );
}
