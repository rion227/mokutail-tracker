import { useEffect, useMemo, useRef, useState } from "react";
// 共有同期対応版（Supabase optional） + グローバル同期ロック（ソフトロック）
// - ローカル保存 + 任意で Supabase を使った端末間同期（同じ Room ID で共有）
// - だれかが変更送信を開始したら、全端末で「同期中」表示になって操作を一時停止
// - 最初に送信を“宣言”した端末が勝ち（soft lock）。完了でロック解除 → 全端末再開
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
  soda_white: 5800,
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
const loadSupabase = async () => {
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
    if (!cid) { cid = `${now}-${Math.random().toString(36).slice(2,8)}`; localStorage.setItem(LS_CLIENT, cid); }
    return cid;
  } catch {
    return `cid-${Math.random().toString(36).slice(2,8)}`;
  }
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

  const [version, setVersion] = useState<number>(() => {
    try { return Number(localStorage.getItem(LS_VER) || '0') || 0; } catch { return 0; }
  });

  const [sbUrl, setSbUrl] = useState(() => { try { return JSON.parse(localStorage.getItem(LS_SYNC) || '{}').url || ''; } catch { return ''; } });
  const [sbKey, setSbKey] = useState(() => { try { return JSON.parse(localStorage.getItem(LS_SYNC) || '{}').key || ''; } catch { return ''; } });
  const [roomId, setRoomId] = useState(() => { try { return JSON.parse(localStorage.getItem(LS_SYNC) || '{}').room || ''; } catch { return ''; } });

  // 接続ボタンの初期表示は「自動再接続フラグ」に従う
  const [connected, setConnected] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_AUTOCONN) === '1'; } catch { return false; }
  });

  const supabaseRef = useRef<any>(null);
  const versionRef = useRef<number>(0);
  const subscriptionRef = useRef<any>(null);
  const applyTimerRef = useRef<any>(null); // Realtime反映のデバウンス

  // ---- lock control (reduce flicker) ----
  const LOCK_TTL_MS = 3000; // 他端末のロック有効時間（ms）
  const lockUntilRef = useRef<number>(0);
  const [lockActive, setLockActive] = useState(false);
  const lockTimerRef = useRef<any>(null);
  const markLockedUntil = (until: number) => {
    lockUntilRef.current = until;
    setLockActive(true);
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    const delay = Math.max(0, until - Date.now());
    lockTimerRef.current = setTimeout(() => setLockActive(false), delay + 50);
  };
  const actionsBlocked = () => pushingRef.current || lockActive;

  // === Sync overlay state ===
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string>("");
  const syncTimerRef = useRef<any>(null);
  const startSync = (msg: string) => {
    setSyncMsg(msg);
    setSyncBusy(true);
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => setSyncBusy(false), 2500);
  };
  const finishSync = () => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => setSyncBusy(false), 150);
  };

  // スクロール保存/復元（手動再読込ボタン用。自動同期ではリロードしない設計に変更）
  const SCROLL_KEY = 'mt_scrollY';
  const reloadWithScrollSave = () => { try { sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || 0)); } catch {} window.location.reload(); };
  useEffect(() => {
    try {
      const y = Number(sessionStorage.getItem(SCROLL_KEY) || 'NaN');
      if (Number.isFinite(y)) {
        sessionStorage.removeItem(SCROLL_KEY);
        setTimeout(() => window.scrollTo(0, y), 0);
      }
    } catch { /* noop */ }
  }, []);

  // ローカル永続化
  useEffect(() => { localStorage.setItem(LS_INV, JSON.stringify(inventory)); }, [inventory]);
  useEffect(() => { localStorage.setItem(LS_BASE, JSON.stringify(baseline)); }, [baseline]);
  useEffect(() => { localStorage.setItem(LS_COUNTS, JSON.stringify(counts)); }, [counts]);
  useEffect(() => { localStorage.setItem(LS_VER, String(version)); versionRef.current = version; }, [version]);
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

  const updateBaselineIfIncreased = (key: keyof Inventory, nextVal: number) => {
    setBaseline((prev: Baseline) => ({ ...prev, [key]: Math.max((prev as any)[key] ?? 0, nextVal) } as Baseline));
  };

  // ---- actions ----
  const makeOne = (recipeKey: string) => {
    const check = canMake(recipeKey);
    if (!check.ok || actionsBlocked()) return;
    const recipe = RECIPES[recipeKey];
    setInventory((prev: Inventory) => {
      const next: Inventory = { ...prev } as Inventory;
      for (const k in recipe) (next as any)[k] = Math.max(0, (next as any)[k] as number - recipe[k]);
      return next;
    });
    setCounts((prev: Counts) => ({ ...prev, [recipeKey]: (prev[recipeKey] || 0) + 1 }));
  };

  const undoOne = (recipeKey: string) => {
    if (actionsBlocked()) return;
    setCounts((prev: Counts) => { const cur = prev[recipeKey] || 0; if (cur <= 0) return prev; return { ...prev, [recipeKey]: cur - 1 }; });
    const recipe = RECIPES[recipeKey];
    setInventory((prev: Inventory) => {
      const next: Inventory = { ...prev } as Inventory;
      for (const k in recipe) (next as any)[k] = Math.max(0, (next as any)[k] as number + recipe[k]);
      return next;
    });
  };

  const resetAll = () => {
    if (actionsBlocked()) return;
    setInventory(INITIAL_INVENTORY);
    setBaseline(INITIAL_INVENTORY);
    const o: Counts = {}; (Object.keys(RECIPES) as string[]).forEach((k) => (o[k] = 0)); setCounts(o);
  };

  const setInventoryValue = (key: keyof Inventory, value: number) => {
    if (actionsBlocked()) return;
    const v = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    setInventory((prev: Inventory) => ({ ...prev, [key]: v } as Inventory));
    updateBaselineIfIncreased(key, v);
  };
  const bumpInventory = (key: keyof Inventory, delta: number) => {
    if (actionsBlocked()) return;
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

  // ====== ソフトロック付き同期 ======
  const clientId = useRef<string>(ensureClientId());
  const pushingRef = useRef(false);

  type RemotePayload = {
    inventory: Inventory;
    baseline: Baseline;
    counts: Counts;
    version: number;
    updated_at: string;
    // soft lock
    sync?: { busy: boolean; owner: string; started_at: number };
  };

  const buildPayload = (partial?: Partial<RemotePayload>): RemotePayload => ({
    inventory, baseline, counts, version,
    updated_at: new Date().toISOString(),
    sync: { busy: false, owner: clientId.current, started_at: Date.now() },
    ...(partial || {}),
  });

  const clearAutoConn = () => {
    try { localStorage.removeItem(LS_AUTOCONN); } catch {}
    setConnected(false);
  };

  const setAutoConnOn = () => {
    try { localStorage.setItem(LS_AUTOCONN, '1'); } catch {}
  };

  const connectSupabase = async (): Promise<boolean> => {
    try {
      const cc = await loadSupabase();
      if (!cc) {
        alert(`supabase-js が見つかりません。\nnpm i @supabase/supabase-js を実行してください。`);
        clearAutoConn();
        return false;
      }
      if (!sbUrl || !sbKey || !roomId) {
        alert('Supabase URL / anon key / Room ID を入力してください');
        clearAutoConn();
        return false;
      }

      const sb = cc(sbUrl, sbKey);
      supabaseRef.current = sb;
      setConnected(true);
      startSync('接続中…');

      const { data: got, error: selErr } = await sb.from('rooms').select('id,payload').eq('id', roomId).maybeSingle();
      if (selErr) {
        console.error(selErr);
      }
      if (got && (got as any).payload) {
        const remote = (got as any).payload as RemotePayload;
        const remoteVer = Number(remote?.version || 0);
        if (remoteVer > version) {
          setInventory(remote.inventory); setBaseline(remote.baseline); setCounts(remote.counts); setVersion(remoteVer);
        }
      } else {
        const { error: upErr } = await sb.from('rooms').upsert({ id: roomId, payload: buildPayload() }, { onConflict: 'id' });
        if (upErr) throw upErr;
      }

      // Realtime 購読（ページリロードせずに反映）
      if (subscriptionRef.current) sb.removeChannel(subscriptionRef.current);
      const handler = (ev: any) => {
        try {
          const remote = ev?.new?.payload as RemotePayload;
          if (!remote) return;
          // ロック情報を更新（他端末が busy の間のみ操作ブロック）
          const busy = !!remote?.sync?.busy;
          const owner = remote?.sync?.owner;
          const started = Number(remote?.sync?.started_at || 0);
          if (busy && owner && owner !== clientId.current) {
            const until = started + LOCK_TTL_MS;
            if (until > Date.now()) markLockedUntil(until);
          }

          const remoteVer = Number(remote?.version || 0);
          if (pushingRef.current) return; // 自分の反射は無視
          if (remoteVer <= Number(versionRef.current || 0)) return; // 古い/同一バージョンはスキップ

          // ページリロードはせず、静かに適用（デバウンス）
          if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
          applyTimerRef.current = setTimeout(() => {
            setInventory(remote.inventory);
            setBaseline(remote.baseline);
            setCounts(remote.counts);
            setVersion(remoteVer);
          }, 100);
        } catch { /* noop */ }
      };
      const channel = sb
        .channel(`rooms:${roomId}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, handler)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, handler)
        .subscribe();
      subscriptionRef.current = channel;

      // 成功したので自動再接続フラグ ON
      setAutoConnOn();
      finishSync();
      return true;
    } catch (e) {
      console.error(e);
      clearAutoConn();
      return false;
    }
  };

  // 変更時 push（ソフトロック: 送信前に busy=true を広報 → 最終状態を busy=false で確定）
  useEffect(() => {
    const push = async () => {
      if (!connected || !supabaseRef.current || !roomId) return;

      const sb = supabaseRef.current;

      // 直近のリモートを確認。誰かが busy(true) なら、TTL内は自分の送信を少し遅らせる（リトライ）
      const { data } = await sb.from('rooms').select('payload').eq('id', roomId).maybeSingle();
      const remote = data?.payload as RemotePayload | undefined;
      if (remote?.sync?.busy && remote.sync.owner !== clientId.current) {
        const started = Number(remote.sync.started_at || 0);
        const until = started + LOCK_TTL_MS;
        const delay = Math.max(0, until - Date.now()) + 200;
        markLockedUntil(until);
        setTimeout(push, delay);
        return;
      }

      // 自分がロック告知
      const announce = buildPayload({ sync: { busy: true, owner: clientId.current, started_at: Date.now() } });
      pushingRef.current = true;
      startSync('同期中…');
      await sb.from('rooms').upsert({ id: roomId, payload: announce }, { onConflict: 'id' });

      // 最終状態をコミット（busy=false）
      const nextVersion = Number(version) + 1;
      const finalPayload = buildPayload({ version: nextVersion, sync: { busy: false, owner: clientId.current, started_at: Date.now() } });
      await sb.from('rooms').upsert({ id: roomId, payload: finalPayload }, { onConflict: 'id' });
      setVersion(nextVersion);
      setTimeout(() => { pushingRef.current = false; finishSync(); }, 120);
    };
    push();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory, baseline, counts]);

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
    const invFewSoda = { ...INITIAL_INVENTORY, soda_tropical: 110 } as typeof INITIAL_INVENTORY; eq("トロピカル 1杯", servingsLeftWith(invFewSoda as Inventory, "トロピカルスカッシュ / すっきり"), 1);
    const invMoreSoda = { ...invFewSoda, soda_tropical: 220 } as typeof INITIAL_INVENTORY; eq("トロピカル 2杯", servingsLeftWith(invMoreSoda as Inventory, "トロピカルスカッシュ / すっきり"), 2);
    const afterOne = { ...INITIAL_INVENTORY, white_peach_syrup: INITIAL_INVENTORY.white_peach_syrup - 20, soda_white: INITIAL_INVENTORY.soda_white - 120, peach_pieces: INITIAL_INVENTORY.peach_pieces - 1 } as typeof INITIAL_INVENTORY;
    eq("白桃さっぱり 1杯後 max", servingsLeftWith(afterOne as any, "白桃スカッシュ / さっぱり"), 39);

    // 追加ケース: canMake が ok=false を返す状況
    const invLackSyrup = { ...INITIAL_INVENTORY, white_peach_syrup: 19 } as typeof INITIAL_INVENTORY;
    eq("白桃さっぱり syrup不足で作れない", canMakeWith(invLackSyrup as Inventory, "白桃スカッシュ / さっぱり").ok, false);
    const invLackSoda = { ...INITIAL_INVENTORY, soda_white: 119 } as typeof INITIAL_INVENTORY;
    eq("白桃さっぱり soda不足で作れない", canMakeWith(invLackSoda as Inventory, "白桃スカッシュ / さっぱり").ok, false);

    // 追加ケース: perCupCost が0より大
    const costPeach = ((): number => {
      const r = RECIPES["白桃スカッシュ / さっぱり"]; let c = 0; for (const k in r) c += (k === 'peach_pieces' ? PEACH_GARNISH_COST : (UNIT_COSTS as any)[k] || 0) * (r as any)[k]; return Math.round(c*10)/10; })();
    eq("1杯原価>0", costPeach > 0, true);

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
            <button onClick={reloadWithScrollSave} className="px-3 py-2 rounded-2xl bg-white hover:bg-neutral-100 text-neutral-900 border border-neutral-200 shadow" title="ページを再読み込み">再読み込み</button>
            <button onClick={resetAll} className="px-4 py-2 rounded-2xl bg-neutral-900 text-white hover:bg-neutral-800 shadow" disabled={actionsBlocked()}>リセット</button>
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
          <p className="text-xs text-neutral-500 mt-1">※ だれかが送信を開始すると全端末で「同期中」表示になり、完了で解除されます（ソフトロック）。</p>
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
                {(() => {
                  const disabledMake = !ok || actionsBlocked();
                  const disabledUndo = (counts[key] || 0) === 0 || actionsBlocked();
                  return (
                    <div className="mt-auto flex gap-2">
                      <button
                        onClick={() => makeOne(key)}
                        disabled={disabledMake}
                        className={`px-4 py-2 rounded-xl font-medium shadow transition ${disabledMake ? "bg-neutral-200 text-neutral-500 cursor-not-allowed" : "bg-emerald-600 hover:bg-emerald-700 text-white"}`}
                      >
                        1杯作る
                      </button>
                      <button
                        onClick={() => undoOne(key)}
                        disabled={disabledUndo}
                        className={`px-4 py-2 rounded-xl font-medium shadow transition ${disabledUndo ? "bg-neutral-200 text-neutral-500 cursor-not-allowed" : "bg-red-600 hover:bg-red-700 text-white"}`}
                        title="直前の誤操作などを取り消して1杯分を在庫に戻します"
                      >
                        1杯減らす
                      </button>
                    </div>
                  );
                })()}

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

        {/* 中央の小さな同期ポップ */}
        {syncBusy && (
          <div className="fixed inset-0 pointer-events-none flex items-start justify-center">
            <div className="mt-10 px-4 py-2 rounded-xl shadow bg-neutral-900/90 text-white text-sm flex items-center gap-2">
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
              </svg>
              <span>{syncMsg || '同期中…'}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
