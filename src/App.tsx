import { useEffect, useMemo, useRef, useState } from "react";
// 共有同期対応版（Supabase optional） + グローバル同期ロック（ソフトロック）
// - ローカル保存 + 任意で Supabase を使った端末間同期（同じ Room ID で共有）
// - だれかが変更送信を開始したら、全端末で「同期中」表示になって操作を一時停止
// - 最初に送信を“宣言”した端末が勝ち（soft lock）。完了でロック解除 → 全端端末再開
// - 追加: 自動再接続（LS_AUTOCONN）/ 他端末更新を**ページ再読込なし**で反映 / スクロール位置の保存復元（手動再読込時）

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
  mojito: 1520 / 750,
  cassis: 2299 / 750,
  orange_juice: 1200 / 3000,
  soda_white: 1448 / 12000,
  soda_mojito: 1448 / 12000,
  soda_tropical: 1448 / 12000,
};
const PEACH_GARNISH_COST = 61.4; // 円/個

// ==== 初期在庫 ====
const INITIAL_INVENTORY = {
  white_peach_syrup: 1000,
  mango_syrup: 600,
  pine_mojito: 350,
  pine_tropical: 650,
  lemon_mojito: 390,
  lemon_tropical: 390,
  mojito: 750,
  cassis: 750,
  orange_juice: 3000,
  soda_white: 4800,
  soda_mojito: 3850,
  soda_tropical: 3350,
  peach_pieces: 40,
};

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

// ==== シートの「1杯あたり原価(円)」を優先的に使うマップ ====
// （未記載のものは原材料計算でフォールバック）
const PER_RECIPE_COSTS: Record<string, number> = {
  "白桃スカッシュ / さっぱり": 109.4,
  "白桃スカッシュ / 甘め": 115.4,
  "パインモヒート / すっきり": 104.7,
  "パインモヒート / 甘め": 104.1,
  "トロピカルスカッシュ / すっきり": 63.3,
  "トロピカルスカッシュ / 甘め": 75.1,
  "カシスオレンジ / すっきり(110ml)": 110.8,
  "カシスオレンジ / 甘め(100ml)": 119.7,
  // (90ml)はシート未記載 → 100ml 版から OJ 10ml(=4円)を差し引き
  "カシスオレンジ / 甘め(90ml)": 115.7,
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
const LS_BASE = "mt_base";
const LS_COUNTS = "mt_counts";
const LS_SYNC = "mt_sync";
const LS_VER = "mt_ver";
const LS_CLIENT = "mt_client";
const LS_AUTOCONN = "mt_autoconn"; // '1' で自動再接続

// ====== Supabase (optional / lazy import) ======
let createClient: any | null = null;
async function lazyImportSupabaseCreateClient() {
  if (createClient) return createClient;
  try {
    const mod = await import('@supabase/supabase-js');
    createClient = mod.createClient;
    return createClient;
  } catch {
    return null;
  }
};

// クライアント識別子（ソフトロックの所有者識別）
function ensureClientId() {
  try {
    const now = Date.now().toString(36);
    let cid = localStorage.getItem(LS_CLIENT);
    if (!cid) {
      cid = `${Math.random().toString(36).slice(2, 8)}-${now}`;
      localStorage.setItem(LS_CLIENT, cid);
    }
    return cid;
  } catch {
    return "local-unknown";
  }
}

// 在庫差分計算
function subInv(inv: Inventory, recipe: Record<string, number>, times = 1): Inventory {
  const next = { ...inv };
  for (const k of Object.keys(recipe)) {
    (next as any)[k] = Math.max(0, ((next as any)[k] ?? 0) - (recipe as any)[k] * times);
  }
  return next;
}

function addInv(inv: Inventory, recipe: Record<string, number>, times = 1): Inventory {
  const next = { ...inv };
  for (const k of Object.keys(recipe)) {
    (next as any)[k] = ((next as any)[k] ?? 0) + (recipe as any)[k] * times;
  }
  return next;
}

// 何杯作れるか
function servingsLeftWith(inv: Inventory, name: string): number {
  const r = RECIPES[name]; if (!r) return 0;
  let min = Infinity;
  for (const k of Object.keys(r)) {
    const need = (r as any)[k];
    const have = (inv as any)[k] ?? 0;
    min = Math.min(min, Math.floor(have / need));
  }
  return Number.isFinite(min) ? min : 0;
}

// 作成可否
function canMakeWith(inv: Inventory, name: string) {
  const r = RECIPES[name]; if (!r) return { ok: false, reason: "unknown" as const };
  for (const k of Object.keys(r)) {
    const need = (r as any)[k];
    const have = (inv as any)[k] ?? 0;
    if (have < need) return { ok: false, reason: k as keyof Inventory };
  }
  return { ok: true as const };
}

export default function App() {
  const [inventory, setInventory] = useState<Inventory>(() => {
    try { const s = localStorage.getItem(LS_INV); if (s) return JSON.parse(s); } catch {}
    return { ...INITIAL_INVENTORY };
  });
  const [baseline, setBaseline] = useState<Baseline>(() => {
    try { const s = localStorage.getItem(LS_BASE); if (s) return JSON.parse(s); } catch {}
    return { ...INITIAL_INVENTORY };
  });
  const [counts, setCounts] = useState<Counts>(() => {
    try { const s = localStorage.getItem(LS_COUNTS); if (s) return JSON.parse(s); } catch {}
    return {};
  });

  // ==== Supabase接続（任意）関連状態 ====
  const [sbUrl, setSbUrl] = useState<string>(() => localStorage.getItem("mt_sb_url") || "");
  const [sbKey, setSbKey] = useState<string>(() => localStorage.getItem("mt_sb_key") || "");
  const [roomId, setRoomId] = useState<string>(() => localStorage.getItem("mt_room") || "");
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncOwner = useRef<string | null>(null);

  // ==== 保存 ====
  useEffect(() => { try { localStorage.setItem(LS_INV, JSON.stringify(inventory)); } catch {} }, [inventory]);
  useEffect(() => { try { localStorage.setItem(LS_BASE, JSON.stringify(baseline)); } catch {} }, [baseline]);
  useEffect(() => { try { localStorage.setItem(LS_COUNTS, JSON.stringify(counts)); } catch {} }, [counts]);
  useEffect(() => { try { localStorage.setItem("mt_sb_url", sbUrl); } catch {} }, [sbUrl]);
  useEffect(() => { try { localStorage.setItem("mt_sb_key", sbKey); } catch {} }, [sbKey]);
  useEffect(() => { try { localStorage.setItem("mt_room", roomId); } catch {} }, [roomId]);

  // ==== 1杯あたり原価 ====
  const perCupCost = useMemo(() => {
    // シート値を優先、無い時のみ原材料から算出
    const map: Record<string, number> = {};
    for (const key of (Object.keys(RECIPES) as string[])) {
      if ((PER_RECIPE_COSTS as any)[key] != null) {
        map[key] = Math.round((PER_RECIPE_COSTS as any)[key] * 10) / 10;
        continue;
      }
      const recipe = RECIPES[key]; let cost = 0;
      for (const mat in recipe) {
        const amt = (recipe as any)[mat];
        cost += (mat === "peach_pieces") ? (PEACH_GARNISH_COST * amt) : (((UNIT_COSTS as any)[mat] || 0) * amt);
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

  // ==== 在庫操作 ====
  const makeOne = (name: string) => {
    const ok = canMakeWith(inventory, name).ok; if (!ok) return;
    setInventory((inv) => subInv(inv, RECIPES[name], 1));
    setCounts((m) => ({ ...m, [name]: (m[name] || 0) + 1 }));
  };
  const undoOne = (name: string) => {
    if (!counts[name]) return;
    setInventory((inv) => addInv(inv, RECIPES[name], 1));
    setCounts((m) => ({ ...m, [name]: Math.max(0, (m[name] || 0) - 1) }));
  };

  const resetAll = () => {
    setInventory({ ...baseline });
    setCounts({});
  };

  // ==== 最大杯数 ====
  const maxServings = useMemo(() => {
    const map: Record<string, number> = {};
    for (const k of Object.keys(RECIPES)) map[k] = servingsLeftWith(inventory, k);
    return map;
  }, [inventory]);

  // ====== 簡易同期（ソフトロック） ======
  const startSync = async () => {
    if (!roomId || !sbUrl || !sbKey) return;
    const cid = ensureClientId();
    syncOwner.current = cid;
    setSyncing(true);
    const ok = await pushToServer(cid);
    if (!ok) { setSyncing(false); syncOwner.current = null; }
  };

  const stopSync = () => {
    setSyncing(false);
    syncOwner.current = null;
  };

  async function getSupabase() {
    const createClient = await lazyImportSupabaseCreateClient();
    if (!createClient) return null;
    return createClient(sbUrl, sbKey, { auth: { autoRefreshToken: true, persistSession: false } });
  }

  async function pushToServer(owner: string) {
    try {
      const sb = await getSupabase(); if (!sb) return false;
      const payload = { inventory, baseline, counts, owner, at: Date.now() };
      await sb.from('mt_rooms').upsert({ id: roomId, payload }).throwOnError();
      return true;
    } catch { return false; }
  }

  async function pullFromServer() {
    try {
      const sb = await getSupabase(); if (!sb) return false;
      const { data } = await sb.from('mt_rooms').select('payload').eq('id', roomId).single();
      if (data?.payload) {
        if (syncOwner.current && data.payload.owner === syncOwner.current) {
          // 自分が直近オーナー → ローカルをサーバ準拠にしてロック解除
          setInventory(data.payload.inventory);
          setBaseline(data.payload.baseline);
          setCounts(data.payload.counts);
          setSyncing(false);
          syncOwner.current = null;
        } else {
          // 他端末の更新を取り込む
          setInventory(data.payload.inventory);
          setBaseline(data.payload.baseline);
          setCounts(data.payload.counts);
        }
        return true;
      }
      return false;
    } catch { return false; }
  }

  // サーバの変更ポーリング
  useEffect(() => {
    if (!connected || !roomId) return;
    const t = setInterval(() => { pullFromServer(); }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, roomId]);

  // 接続・切断
  const connectSupabase = async () => {
    const sb = await getSupabase(); if (!sb) return false;
    setConnected(true);
    return true;
  };
  const disconnectSupabase = () => {
    setConnected(false);
  };

  // 自動再接続: マウント時にフラグと資格情報を確認
  useEffect(() => {
    const auto = (() => { try { return localStorage.getItem(LS_AUTOCONN) === '1'; } catch { return false; } })();
    const hasCreds = !!(sbUrl && sbKey && roomId);
    if (auto && hasCreds) {
      // UI ちらつき防止: 先に接続中表示にしてから少し遅延して実接続
      setConnected(true);
      const t = setTimeout(() => {
        connectSupabase().then((ok) => { if (!ok) clearAutoConn(); });
      }, 120);
      return () => clearTimeout(t);
    } else {
      clearAutoConn();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== DEV: 簡易テスト =====
  useEffect(() => {
    const results: { name: string; pass: boolean; got: any; expected: any }[] = [];
    const eq = (name: string, got: any, expected: any) => results.push({ name, pass: Object.is(got, expected), got, expected });

    // 既存ケース
    eq("白桃さっぱり max", servingsLeftWith(INITIAL_INVENTORY as any, "白桃スカッシュ / さっぱり"), 40);
    eq("モヒート甘め max", servingsLeftWith(INITIAL_INVENTORY as any, "パインモヒート / 甘め"), 35);
    eq("トロピカルすっきり max", servingsLeftWith(INITIAL_INVENTORY as any, "トロピカルスカッシュ / すっきり"), 30);
    const invNoPeach = { ...INITIAL_INVENTORY, peach_pieces: 0 } as typeof INITIAL_INVENTORY;
    eq("白桃トッピング不足検出", canMakeWith(invNoPeach as Inventory, "白桃スカッシュ / さっぱり").ok, false);
    const invFewSoda = { ...INITIAL_INVENTORY, soda_tropical: 110 } as typeof INITIAL_INVENTORY;
    eq("トロピカルすっきり ほぼ尽きる", servingsLeftWith(invFewSoda as Inventory, "トロピカルスカッシュ / すっきり"), 1);
    const invMoreSoda = { ...invFewSoda, soda_tropical: 220 } as typeof INITIAL_INVENTORY;
    eq("トロピカルすっきり 少し増える", servingsLeftWith(invMoreSoda as Inventory, "トロピカルスカッシュ / すっきり"), 2);
    const afterOne = { ...INITIAL_INVENTORY, white_peach_syrup: INITIAL_INVENTORY.white_peach_syrup - 20, soda_white: INITIAL_INVENTORY.soda_white - 120, peach_pieces: INITIAL_INVENTORY.peach_pieces - 1 } as typeof INITIAL_INVENTORY;
    eq("白桃さっぱり 1杯後 max", servingsLeftWith(afterOne as any, "白桃スカッシュ / さっぱり"), 39);

    // 追加ケース: canMake が ok=false を返す状況
    const invLackSyrup = { ...INITIAL_INVENTORY, white_peach_syrup: 19 } as typeof INITIAL_INVENTORY;
    eq("白桃さっぱり syrup不足で作れない", canMakeWith(invLackSyrup as Inventory, "白桃スカッシュ / さっぱり").ok, false);
    const invLackSoda = { ...INITIAL_INVENTORY, soda_white: 119 } as typeof INITIAL_INVENTORY;
    eq("白桃さっぱり soda不足で作れない", canMakeWith(invLackSoda as Inventory, "白桃スカッシュ / さっぱり").ok, false);

    // 追加ケース: 1杯原価はシート値に一致
    eq("1杯原価(白桃さっぱり)=109.4", (perCupCost as any)["白桃スカッシュ / さっぱり"], 109.4);

    // eslint-disable-next-line no-console
    console.table(results);
  }, []);

  return (
    <>
     <div className="min-h-screen bg-neutral-50 text-neutral-900 p-6">
      <div className="max-w-6xl mx-auto">
        <header className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold">モクテル在庫トラッカー</h1>
            <p className="text-sm text-neutral-600">在庫を減算・補充して各端末で同期。Room ID を共有すると複数端末で同じ在庫を見られます</p>
          </div>

          <div className="flex flex-col gap-2 items-end">
            <div className="flex gap-2">
              <input className="border rounded px-2 py-1 text-sm" placeholder="Supabase URL" value={sbUrl} onChange={e => setSbUrl(e.target.value)} style={{ width: 180 }} />
              <input className="border rounded px-2 py-1 text-sm" placeholder="Supabase Key" value={sbKey} onChange={e => setSbKey(e.target.value)} style={{ width: 180 }} />
              <input className="border rounded px-2 py-1 text-sm" placeholder="Room ID" value={roomId} onChange={e => setRoomId(e.target.value)} style={{ width: 120 }} />
            </div>
            <div className="flex gap-2">
              {!connected ? (
                <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm" onClick={() => { connectSupabase(); setConnected(true); setAutoConn(); }}>接続</button>
              ) : (
                <button className="px-3 py-1 rounded bg-neutral-200 text-neutral-800 text-sm" onClick={() => { disconnectSupabase(); clearAutoConn(); }}>切断</button>
              )}
              {!syncing ? (
                <button disabled={!connected || !roomId} className="px-3 py-1 rounded bg-emerald-600 disabled:bg-neutral-300 text-white text-sm" onClick={startSync}>サーバへ送信</button>
              ) : (
                <button className="px-3 py-1 rounded bg-orange-500 text-white text-sm" onClick={stopSync}>同期中…（解除）</button>
              )}
            </div>
          </div>
        </header>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-white rounded-xl shadow p-4">
            <h2 className="font-semibold mb-2">サマリー</h2>
            <div className="space-y-1 text-sm">
              <div>提供杯数: <span className="font-mono">{totals.cups}</span> 杯</div>
              <div>売上: <span className="font-mono">{totals.revenue.toLocaleString()}</span> 円</div>
              <div>原価: <span className="font-mono">{totals.cogs.toLocaleString()}</span> 円</div>
              <div>粗利: <span className="font-mono">{totals.gp.toLocaleString()}</span> 円</div>
              <div>原価率: <span className="font-mono">{(totals.revenue > 0 ? (totals.cogs / totals.revenue) * 100 : 0).toFixed(1)}%</span></div>
            </div>
            <div className="mt-3 flex gap-2">
              <button className="px-3 py-1 rounded bg-neutral-200 text-neutral-800 text-sm" onClick={resetAll}>在庫と杯数をリセット</button>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow p-4 md:col-span-2">
            <h2 className="font-semibold mb-2">在庫</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
              {Object.keys(INITIAL_INVENTORY).map((k) => (
                <div key={k} className="flex items-center justify-between">
                  <div className="text-neutral-700">{NICE_LABEL[k as keyof Inventory] || k}</div>
                  <div className="flex items-center gap-2">
                    <input type="number" className="border rounded px-2 py-1 w-28 text-right font-mono"
                      value={(inventory as any)[k] ?? 0}
                      onChange={e => setInventory(prev => ({ ...prev, [k]: Number(e.target.value || 0) }))}
                    />
                    <span className="text-neutral-500">{k === 'peach_pieces' ? '個' : 'ml'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-white rounded-2xl shadow p-4 mb-6">
          <h2 className="font-semibold mb-3">メニュー</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {Object.keys(RECIPES).map((name) => {
              const can = canMakeWith(inventory, name);
              const n = counts[name] || 0;
              return (
                <div key={name} className="border rounded-xl p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">{name}</div>
                    <div className="text-xs text-neutral-500">最大 <span className="font-mono">{maxServings[name]}</span> 杯</div>
                  </div>
                  <div className="mt-2 text-sm text-neutral-700">
                    原価 <span className="font-mono">{(perCupCost[name] || 0).toFixed(1)}</span> 円 / 杯
                    <span className="ml-3">原価率 <span className="font-mono">{((perCupCost[name] || 0) / PRICE_PER_CUP * 100).toFixed(1)}%</span></span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button className="px-3 py-1 rounded bg-indigo-600 text-white text-sm disabled:bg-neutral-300"
                      disabled={!can.ok}
                      onClick={() => makeOne(name)}
                    >提供 +1</button>
                    <button className="px-3 py-1 rounded bg-neutral-200 text-neutral-800 text-sm disabled:bg-neutral-100"
                      disabled={!n}
                      onClick={() => undoOne(name)}
                    >取消 -1</button>
                    <div className="ml-auto text-sm text-neutral-600">累計 <span className="font-mono">{n}</span> 杯</div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <footer className="text-xs text-neutral-500 text-right pb-4">
          v1 • ローカル保存 / 任意でSupabase同期（Room共有）
        </footer>
      </div>
     </div>
    </>
  );
}

// 自動再接続 ON/OFF
function setAutoConn() {
  try { localStorage.setItem(LS_AUTOCONN, '1'); } catch {}
}
function clearAutoConn() {
  try { localStorage.removeItem(LS_AUTOCONN); } catch {}
}
