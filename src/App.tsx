import { useEffect, useMemo, useRef, useState } from "react";
// 共有同期対応版（Supabase optional）
// - ローカル保存 + 任意で Supabase を使った端末間同期（同じ Room ID で共有）
// - Room に接続すると、在庫/基準/カウントをクラウドへ保存し、他端末とリアルタイム同期
// - 既存機能：在庫編集・残量バー（補充時100%）・取り消し・売上/原価サマリー

// ==== 売価設定 ====
const PRICE_PER_CUP = 300; // 円

// ==== 原価単価（円/ml 相当）====
const UNIT_COSTS: Record<string, number> = {
  white_peach_syrup: 1678 / 1000,
  mango_syrup: 867 / 600,
  pine_mojito: 1398 / 1000,
  pine_tropical: 1398 / 1000,
  lemon_mojito: 1218 / 780,
  lemon_tropical: 1218 / 780,
  mojito: 1520 / 700,
  cassis: 2299 / 700,
  orange_juice: 1200 / 3000,
  soda_white: 1448 / 12000,
  soda_mojito: 1448 / 12000,
  soda_tropical: 1448 / 12000,
};
const PEACH_GARNISH_COST = 2068 / 40; // 円/個

// ==== 初期在庫 ====
const INITIAL_INVENTORY = {
  white_peach_syrup: 1000,
  mango_syrup: 600,
  pine_mojito: 350,
  pine_tropical: 650,
  lemon_mojito: 390,
  lemon_tropical: 390,
  mojito: 700,
  cassis: 700,
  orange_juice: 3000,
  soda_white: 4800,
  soda_mojito: 3850,
  soda_tropical: 3350,
  peach_pieces: 40,
};

// 型エイリアス（TS CI 対策）
type Inventory = typeof INITIAL_INVENTORY;
type Counts = Record<string, number>;
type Baseline = typeof INITIAL_INVENTORY;

// ==== レシピ（ml / 個）====
const RECIPES: Record<string, Record<string, number>> = {
  "白桃スカッシュ / さっぱり": { white_peach_syrup: 20, soda_white: 120, peach_pieces: 1 },
  "白桃スカッシュ / 甘め": { white_peach_syrup: 25, soda_white: 100, peach_pieces: 1 },
  "パインモヒート / すっきり": { mojito: 20, pine_mojito: 10, lemon_mojito: 5, soda_mojito: 90 },
  "パインモヒート / 甘め": { mojito: 20, pine_mojito: 10, lemon_mojito: 3, soda_mojito: 110 },
  "トロピカルスカッシュ / すっきり": { mango_syrup: 10, pine_tropical: 20, lemon_tropical: 5, soda_tropical: 110 },
  "トロピカルスカッシュ / 甘め": { mango_syrup: 15, pine_tropical: 25, lemon_tropical: 5, soda_tropical: 90 },
  "カシスオレンジ / すっきり(110ml)": { cassis: 20, orange_juice: 110 },
  "カシスオレンジ / 甘め(100ml)": { cassis: 25, orange_juice: 100 },
  "カシスオレンジ / 甘め(90ml)": { cassis: 25, orange_juice: 90 },
};

const NICE_LABEL: Record<string, string> = {
  white_peach_syrup: "白桃シロップ",
  mango_syrup: "マンゴー",
  pine_mojito: "パイン(モヒート)",
  pine_tropical: "パイン(トロピカル)",
  lemon_mojito: "レモン(モヒート)",
  lemon_tropical: "レモン(トロピカル)",
  mojito: "モヒート",
  cassis: "カシス",
  orange_juice: "オレンジジュース",
  soda_white: "炭酸(白桃)",
  soda_mojito: "炭酸(モヒート)",
  soda_tropical: "炭酸(トロピカル)",
  peach_pieces: "白桃トッピング(個)",
};

// === localStorage keys ===
const LS_INV = "mt_inv";
const LS_BASE = "mt_base"; // 残量バー基準
const LS_COUNTS = "mt_counts";
const LS_SYNC = "mt_sync"; // {url,key,room}

// ====== Supabase (optional) ======
// npm i @supabase/supabase-js
let createClient: any;
try {
  // 動的 import（存在しない環境でも壊れないように）
  // @ts-ignore
  createClient = require('@supabase/supabase-js').createClient;
} catch (_) {
  createClient = undefined;
}

export default function App() {
  // ---- state ----
  const [inventory, setInventory] = useState<Inventory>(() => {
    try { const raw = localStorage.getItem(LS_INV); return raw ? JSON.parse(raw) : INITIAL_INVENTORY; } catch { return INITIAL_INVENTORY; }
  });
  const [baseline, setBaseline] = useState<Baseline>(() => {
    try { const raw = localStorage.getItem(LS_BASE); return raw ? JSON.parse(raw) : INITIAL_INVENTORY; } catch { return INITIAL_INVENTORY; }
  });
  const [counts, setCounts] = useState<Counts>(() => {
    try { const raw = localStorage.getItem(LS_COUNTS); if (raw) return JSON.parse(raw); } catch {}
    const o: Counts = {}; (Object.keys(RECIPES) as string[]).forEach((k) => (o[k] = 0)); return o;
  });
  const [editMode, setEditMode] = useState(false);

  // Sync settings
  const [sbUrl, setSbUrl] = useState(() => { try { return JSON.parse(localStorage.getItem(LS_SYNC) || '{}').url || ''; } catch { return ''; } });
  const [sbKey, setSbKey] = useState(() => { try { return JSON.parse(localStorage.getItem(LS_SYNC) || '{}').key || ''; } catch { return ''; } });
  const [roomId, setRoomId] = useState(() => { try { return JSON.parse(localStorage.getItem(LS_SYNC) || '{}').room || ''; } catch { return ''; } });
  const [connected, setConnected] = useState(false);
  const supabaseRef = useRef<any>(null);
  const subscriptionRef = useRef<any>(null);
  const pushingRef = useRef(false); // 反射更新ループ回避

  // ---- persist ----
  useEffect(() => { localStorage.setItem(LS_INV, JSON.stringify(inventory)); }, [inventory]);
  useEffect(() => { localStorage.setItem(LS_BASE, JSON.stringify(baseline)); }, [baseline]);
  useEffect(() => { localStorage.setItem(LS_COUNTS, JSON.stringify(counts)); }, [counts]);
  useEffect(() => { localStorage.setItem(LS_SYNC, JSON.stringify({ url: sbUrl, key: sbKey, room: roomId })); }, [sbUrl, sbKey, roomId]);

  // ---- helpers ----
  const canMakeWith = (inv: Inventory, recipeKey: string) => {
    const recipe = RECIPES[recipeKey];
    const blockers: string[] = [];
    for (const k in recipe) {
      const need = recipe[k];
      const have = inv[k as keyof Inventory] as number;
      if (have < need) blockers.push(NICE_LABEL[k] || k);
    }
    return { ok: blockers.length === 0, blockers };
  };
  const canMake = (recipeKey: string) => canMakeWith(inventory, recipeKey);

  const servingsLeftWith = (inv: Inventory, recipeKey: string) => {
    const recipe = RECIPES[recipeKey];
    let min = Infinity;
    for (const k in recipe) {
      const need = recipe[k];
      const have = inv[k as keyof Inventory] as number;
      const left = Math.floor(have / need);
      if (left < min) min = left;
    }
    return isFinite(min) ? min : 0;
  };
  //const servingsLeft = (recipeKey: string) => servingsLeftWith(inventory, recipeKey);

  const updateBaselineIfIncreased = (key: keyof Inventory, nextVal: number) => {
    setBaseline((prev: Baseline) => ({ ...prev, [key]: Math.max((prev as any)[key] ?? 0, nextVal) } as Baseline));
  };

  // ---- actions ----
  const makeOne = (recipeKey: string) => {
    const check = canMake(recipeKey);
    if (!check.ok) return;
    const recipe = RECIPES[recipeKey];
    setInventory((prev: Inventory) => {
      const next: Inventory = { ...prev } as Inventory;
      for (const k in recipe) (next as any)[k] = Math.max(0, (next as any)[k] as number - recipe[k]);
      return next;
    });
    setCounts((prev: Counts) => ({ ...prev, [recipeKey]: (prev[recipeKey] || 0) + 1 }));
  };

  const undoOne = (recipeKey: string) => {
    setCounts((prev: Counts) => { const cur = prev[recipeKey] || 0; if (cur <= 0) return prev; return { ...prev, [recipeKey]: cur - 1 }; });
    const recipe = RECIPES[recipeKey];
    setInventory((prev: Inventory) => {
      const next: Inventory = { ...prev } as Inventory;
      for (const k in recipe) (next as any)[k] = Math.max(0, (next as any)[k] as number + recipe[k]);
      return next;
    });
  };

  const resetAll = () => {
    setInventory(INITIAL_INVENTORY);
    setBaseline(INITIAL_INVENTORY);
    const o: Counts = {}; (Object.keys(RECIPES) as string[]).forEach((k) => (o[k] = 0)); setCounts(o);
  };

  // 在庫手動編集（この操作で 100% 基準更新）
  const setInventoryValue = (key: keyof Inventory, value: number) => {
    const v = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    setInventory((prev: Inventory) => ({ ...prev, [key]: v } as Inventory));
    updateBaselineIfIncreased(key, v);
  };
  const bumpInventory = (key: keyof Inventory, delta: number) => {
    setInventory((prev: Inventory) => {
      const nextVal = Math.max(0, (prev[key] as number) + delta);
      const next: Inventory = { ...prev, [key]: nextVal } as Inventory;
      updateBaselineIfIncreased(key, nextVal);
      return next;
    });
  };

  // ---- derived ----
  const inventoryList = useMemo<{ key: string; label: string; value: number }[]>(
    () => Object.entries(inventory).map(([k, v]) => ({ key: k, label: NICE_LABEL[k as keyof typeof NICE_LABEL] || k, value: v as number })),
    [inventory]
  );

  const getLevel = (key: keyof Inventory, value: number) => {
    const base = (baseline as any)[key] as number | undefined;
    if (!Number.isFinite(base) || (base as number) <= 0) return "ok";
    const pct = value / (base as number);
    if (pct <= 0.15) return "danger";
    if (pct <= 0.35) return "warn";
    return "ok";
  };

  const leftMap = useMemo(() => {
    const out: Record<string, number> = {};
    for (const key of (Object.keys(RECIPES) as string[])) out[key] = servingsLeftWith(inventory as Inventory, key);
    return out;
  }, [inventory]);

  const perCupCost = useMemo(() => {
    const map: Record<string, number> = {};
    for (const key of (Object.keys(RECIPES) as string[])) {
      const recipe = RECIPES[key]; let cost = 0;
      for (const mat in recipe) {
        const amt = recipe[mat];
        if (mat === "peach_pieces") cost += PEACH_GARNISH_COST * amt; else cost += (UNIT_COSTS[mat] || 0) * amt;
      }
      map[key] = Math.round(cost * 10) / 10;
    }
    return map;
  }, []);

  const totals = useMemo(() => {
    let cups = 0, cogs = 0; for (const k of Object.keys(counts)) { const n = counts[k] || 0; cups += n; cogs += n * (perCupCost[k] || 0); }
    const revenue = cups * PRICE_PER_CUP; const gp = revenue - cogs; const margin = revenue > 0 ? gp / revenue : 0;
    return { cups, revenue, cogs: Math.round(cogs), gp: Math.round(gp), margin };
  }, [counts, perCupCost]);

  // ====== Supabase 同期 ======
  const connectSupabase = async () => {
   if (!createClient) { alert(`supabase-js が見つかりません。\nnpm i @supabase/supabase-js を実行してください。`); return; }
   if (!sbUrl || !sbKey || !roomId) { alert('Supabase URL / anon key / Room ID を入力してください'); return; }
    const sb = createClient(sbUrl, sbKey);
    supabaseRef.current = sb;
    setConnected(true);

    // 初回 pull（存在すれば取得、なければ作成）
    const payload = { inventory, baseline, counts, updated_at: new Date().toISOString() };
    const { data: got } = await sb.from('rooms').select('id,payload').eq('id', roomId).maybeSingle();
    if (got && got.payload) {
      // 競合は updated_at で LWW（新しい方を採用）
      try {
        const remote = got.payload;
        const localTs = Date.parse(payload.updated_at);
        const remoteTs = Date.parse(remote.updated_at || 0);
        if (remoteTs > localTs) {
          pushingRef.current = true;
          setInventory(remote.inventory);
          setBaseline(remote.baseline);
          setCounts(remote.counts);
          setTimeout(() => { pushingRef.current = false; }, 50);
        } else {
          await sb.from('rooms').upsert({ id: roomId, payload }, { onConflict: 'id' });
        }
      } catch {}
    } else {
      await sb.from('rooms').upsert({ id: roomId, payload }, { onConflict: 'id' });
    }

    // Realtime 購読
    if (subscriptionRef.current) sb.removeChannel(subscriptionRef.current);
    const channel = sb
      .channel('room-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, (payloadEv: any) => {
        try {
          const remote = payloadEv?.new?.payload;
          if (!remote) return;
          // 自分が push した直後の反射をスキップ
          if (pushingRef.current) return;
          setInventory(remote.inventory);
          setBaseline(remote.baseline);
          setCounts(remote.counts);
        } catch {}
      })
      .subscribe();
    subscriptionRef.current = channel;
  };

  // 変更時に push（接続中のみ）
  useEffect(() => {
    const push = async () => {
      if (!connected || !supabaseRef.current) return;
      const sb = supabaseRef.current;
      const payload = { inventory, baseline, counts, updated_at: new Date().toISOString() };
      pushingRef.current = true;
      await sb.from('rooms').upsert({ id: roomId, payload }, { onConflict: 'id' });
      setTimeout(() => { pushingRef.current = false; }, 50);
    };
    push();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory, baseline, counts]);

  // ===== DEV: 簡易テスト =====
  useEffect(() => {
    const results: { name: string; pass: boolean; got: any; expected: any }[] = [];
    const eq = (name: string, got: any, expected: any) => results.push({ name, pass: Object.is(got, expected), got, expected });
    eq("白桃さっぱり max", servingsLeftWith(INITIAL_INVENTORY as any, "白桃スカッシュ / さっぱり"), 40);
    eq("モヒート甘め max", servingsLeftWith(INITIAL_INVENTORY as any, "パインモヒート / 甘め"), 35);
    eq("トロピカルすっきり max", servingsLeftWith(INITIAL_INVENTORY as any, "トロピカルスカッシュ / すっきり"), 30);
    const invNoPeach = { ...INITIAL_INVENTORY, peach_pieces: 0 } as typeof INITIAL_INVENTORY;
    const checkPeach = canMakeWith(invNoPeach as Inventory, "白桃スカッシュ / さっぱり");
    eq("白桃トッピング不足検出", checkPeach.ok, false);
    const invFewSoda = { ...INITIAL_INVENTORY, soda_tropical: 110 } as typeof INITIAL_INVENTORY; eq("トロピカル 1杯", servingsLeftWith(invFewSoda as Inventory, "トロピカルスカッシュ / すっきり"), 1);
    const invMoreSoda = { ...invFewSoda, soda_tropical: 220 } as typeof INITIAL_INVENTORY; eq("トロピカル 2杯", servingsLeftWith(invMoreSoda as Inventory, "トロピカルスカッシュ / すっきり"), 2);
    // eslint-disable-next-line no-console
    console.table(results);
  }, []);

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 p-6">
      <div className="max-w-6xl mx-auto">
        <header className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold">モクテル在庫トラッカー</h1>
            <p className="text-sm text-neutral-600">在庫を減算・補充して各端末で同期。Room ID を共有すると複数端末で同じ在庫を見られます。</p>
            <p className="text-xs text-neutral-500 mt-1">※トロピカルは <span className="font-semibold">冷凍マンゴー/冷凍パインを原価・在庫計算から除外</span>。モヒートは <span className="font-semibold">ライムを除外</span>。</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setEditMode((v) => !v)} className={`px-4 py-2 rounded-2xl shadow ${editMode ? "bg-amber-600 hover:bg-amber-700 text-white" : "bg-white hover:bg-neutral-100 text-neutral-900"}`}>{editMode ? "在庫編集: ON" : "在庫編集: OFF"}</button>
            <button onClick={resetAll} className="px-4 py-2 rounded-2xl bg-neutral-900 text-white hover:bg-neutral-800 shadow">リセット</button>
          </div>
        </header>

        {/* 同期設定 */}
        <section className="mb-6">
          <div className="bg-white rounded-2xl shadow p-4 grid md:grid-cols-4 gap-2 text-sm">
            <input className="px-2 py-2 rounded border" placeholder="Supabase URL" value={sbUrl} onChange={(e) => setSbUrl(e.target.value)} />
            <input className="px-2 py-2 rounded border" placeholder="Supabase anon key" value={sbKey} onChange={(e) => setSbKey(e.target.value)} />
            <input className="px-2 py-2 rounded border" placeholder="Room ID（英数・長め推奨）" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            <button className={`px-4 py-2 rounded ${connected ? 'bg-emerald-600 text-white' : 'bg-neutral-900 text-white'}`} onClick={connectSupabase}>{connected ? '接続中' : '接続'}</button>
          </div>
          <p className="text-xs text-neutral-500 mt-1">※ Room ID を知っている人と同期されます。推測されにくい長いIDを使ってください。</p>
        </section>

        {/* 売上・原価サマリー */}
        <section className="mb-6">
          <div className="grid md:grid-cols-4 gap-2 text-sm">
            <div className="bg-white rounded-xl p-3 shadow flex justify-between"><span>売価(1杯)</span><span className="font-mono">¥{PRICE_PER_CUP}</span></div>
            <div className="bg-white rounded-xl p-3 shadow flex justify-between"><span>合計杯数</span><span className="font-mono">{totals.cups}</span></div>
            <div className="bg-white rounded-xl p-3 shadow flex justify-between"><span>売上</span><span className="font-mono">¥{totals.revenue}</span></div>
            <div className="bg-white rounded-xl p-3 shadow flex justify-between"><span>合計原価</span><span className="font-mono">¥{totals.cogs}</span></div>
          </div>
          <div className="grid md:grid-cols-2 gap-2 mt-2 text-sm">
            <div className="bg-white rounded-xl p-3 shadow flex justify-between"><span>粗利</span><span className="font-mono">¥{totals.gp}</span></div>
            <div className="bg-white rounded-xl p-3 shadow flex justify-between"><span>粗利率</span><span className="font-mono">{(totals.margin * 100).toFixed(1)}%</span></div>
          </div>
        </section>

        {/* バリエーション一覧 */}
        <section className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {(Object.keys(RECIPES) as string[]).map((key) => {
            const { ok, blockers } = canMake(key);
            const left = leftMap[key];
            return (
              <div key={key} className="bg-white rounded-2xl shadow p-4 flex flex-col gap-3">
                <div>
                  <h2 className="font-semibold text-lg">{key}</h2>
                  <p className="text-xs text-neutral-500">作成数: <span className="font-mono">{counts[key] || 0}</span> / 可能: <span className="font-mono">{left}</span> 杯 / 1杯原価: <span className="font-mono">¥{perCupCost[key]}</span></p>
                </div>

                {/* 使用材料の明細 */}
                <div className="text-xs bg-neutral-50 rounded-xl p-3">
                  <p className="text-neutral-500 mb-1">1杯あたりの使用量</p>
                  <ul className="grid grid-cols-2 gap-1">
                    {(Object.entries(RECIPES[key]) as [string, number][])?.map(([ik, amount]) => (
                      <li key={ik} className="flex items-center justify-between">
                        <span>{NICE_LABEL[ik as keyof typeof NICE_LABEL] || ik}</span>
                        <span className="font-mono">{amount}{ik === "peach_pieces" ? "個" : "ml"}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* アクション */}
                <div className="mt-auto flex gap-2">
                  <button onClick={() => makeOne(key)} disabled={!ok} className={`px-4 py-2 rounded-xl font-medium shadow transition ${ok ? "bg-emerald-600 hover:bg-emerald-700 text-white" : "bg-neutral-200 text-neutral-500 cursor-not-allowed"}`}>1杯作る</button>
                  <button onClick={() => undoOne(key)} disabled={(counts[key] || 0) === 0} className={`px-4 py-2 rounded-xl font-medium shadow transition ${(counts[key] || 0) > 0 ? "bg-red-600 hover:bg-red-700 text-white" : "bg-neutral-200 text-neutral-500 cursor-not-allowed"}`} title="直前の誤操作などを取り消して1杯分を在庫に戻します">1杯減らす</button>
                </div>

                {!ok && (<div className="text-xs text-red-600">在庫不足：{blockers.join("・")}</div>)}
              </div>
            );
          })}
        </section>

        {/* 在庫サマリー */}
        <section className="mt-8">
          <h3 className="font-semibold mb-3">在庫（残量）</h3>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            {inventoryList.map(({ key, label, value }) => {
              const isPieces = key === "peach_pieces";
              const level = getLevel(key as keyof Inventory, value as number);
              const base = (baseline as any)[key] ?? 0;
              const pct = base > 0 ? Math.min(1, Math.max(0, (value as number) / base)) : 1;
              const wrapCls = level === "danger" ? "border border-red-300 bg-red-50" : level === "warn" ? "border border-amber-300 bg-amber-50" : "border border-neutral-200 bg-white";
              return (
                <div key={key} className={`${wrapCls} rounded-xl p-3 shadow text-sm flex flex-col gap-2`}>
                  <div className="flex items-center justify-between">
                    <span>{label}</span>
                    <span className={`font-mono ${level === "danger" ? "text-red-700" : level === "warn" ? "text-amber-700" : "text-neutral-900"}`}>{value}{isPieces ? "個" : "ml"}</span>
                  </div>
                  {base > 0 && (
                    <div className="h-2 w-full rounded bg-neutral-100 overflow-hidden">
                      <div className={`${level === "danger" ? "bg-red-500" : level === "warn" ? "bg-amber-500" : "bg-emerald-500"} h-full`} style={{ width: `${pct * 100}%` }} aria-hidden />
                    </div>
                  )}
                  {editMode && (
                    <div className="flex items-center gap-2">
                      <input type="number" inputMode="numeric" className="w-28 px-2 py-1 rounded border border-neutral-300 font-mono" value={value as number} onChange={(e) => setInventoryValue(key as keyof Inventory, Number(e.target.value))} />
                      <div className="flex gap-1">
                        {isPieces ? (
                          <>
                            <button className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200" onClick={() => bumpInventory(key as keyof Inventory, 1)}>+1</button>
                            <button className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200" onClick={() => bumpInventory(key as keyof Inventory, 5)}>+5</button>
                            <button className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200" onClick={() => bumpInventory(key as keyof Inventory, 10)}>+10</button>
                          </>
                        ) : (
                          <>
                            <button className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200" onClick={() => bumpInventory(key as keyof Inventory, 50)}>+50</button>
                            <button className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200" onClick={() => bumpInventory(key as keyof Inventory, 100)}>+100</button>
                            <button className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200" onClick={() => bumpInventory(key as keyof Inventory, 500)}>+500</button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-neutral-500 mt-2">※ 在庫を補充（手動編集/＋ボタン）した時点の値が新しい100%になります。作成/取り消しでは基準は更新されません。</p>
        </section>
      </div>
    </div>
  );
}
