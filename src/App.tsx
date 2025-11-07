import { useEffect, useMemo, useRef, useState } from "react";

/* =============================================================================
   モクテル在庫トラッカー（同期付き）
   - 機能は維持しつつ、在庫編集はドラフト→適用で全端末へ反映に変更
   - 再読み込み/接続時はサーバ最新スナップショットを取得してから描画
   ============================================================================= */

/* 売価（1杯あたり） */
const PRICE_PER_CUP = 300; // 円

/* 原価単価（円 / ml 相当） */
const UNIT_COSTS: Record<string, number> = {
  white_peach_syrup: 1678 / 1000,
  mango_syrup: 867 / 600,
  pine_mojito: 1398 / 1000,
  pine_tropical: 1398 / 1000,
  lemon_mojito: (579 + 610) / 780,
  lemon_tropical: (579 + 610) / 780,
  mojito: 2709 / 750,
  cassis: 2091 / 750,
  orange_juice: 1500 / 3000,
  soda_white: 1448 / 12000,
  soda_mojito: 1448 / 12000,
  soda_tropical: 1448 / 12000,
};
const PEACH_GARNISH_COST = (2068 + 386) / 40;

/* 初期在庫 */
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

/* レシピ（「カシスオレンジ / 甘め(90ml)」は削除済） */
const RECIPES: Record<string, Record<string, number>> = {
  "白桃スカッシュ / さっぱり": { white_peach_syrup: 20, soda_white: 120, peach_pieces: 1 },
  "白桃スカッシュ / 甘め": { white_peach_syrup: 25, soda_white: 100, peach_pieces: 1 },
  "パインモヒート / すっきり": { mojito: 20, pine_mojito: 10, lemon_mojito: 5, soda_mojito: 90 },
  "パインモヒート / 甘め": { mojito: 20, pine_mojito: 10, lemon_mojito: 3, soda_mojito: 110 },
  "トロピカルスカッシュ / すっきり": { mango_syrup: 10, pine_tropical: 20, lemon_tropical: 5, soda_tropical: 110 },
  "トロピカルスカッシュ / 甘め": { mango_syrup: 15, pine_tropical: 25, lemon_tropical: 5, soda_tropical: 90 },
  "カシスオレンジ / すっきり(110ml)": { cassis: 20, orange_juice: 110 },
  "カシスオレンジ / 甘め(100ml)": { cassis: 25, orange_juice: 100 },
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

/* 1杯原価（シート優先値を固定で使用） */
const PER_RECIPE_COSTS: Record<string, number> = {
  "白桃スカッシュ / さっぱり": 109.4,
  "白桃スカッシュ / 甘め": 115.4,
  "パインモヒート / すっきり": 104.7,
  "パインモヒート / 甘め": 104.1,
  "トロピカルスカッシュ / すっきり": 63.3,
  "トロピカルスカッシュ / 甘め": 75.1,
  "カシスオレンジ / すっきり(110ml)": 110.8,
  "カシスオレンジ / 甘め(100ml)": 119.7,
};

/* localStorage keys */
const LS_INV = "mt_inv";
const LS_BASE = "mt_base";
const LS_COUNTS = "mt_counts";
const LS_SYNC = "mt_sync";
const LS_VER = "mt_ver";
const LS_CLIENT = "mt_client";
const LS_AUTOCONN = "mt_autoconn";

/* Supabase クライアント（遅延 import） */
let createClient: any | null = null;
const loadSupabase = async () => {
  if (createClient) return createClient;
  try {
    const mod = await import("@supabase/supabase-js");
    createClient = mod.createClient;
    return createClient;
  } catch {
    return null;
  }
};

function ensureClientId() {
  try {
    const now = Date.now().toString(36);
    let cid = localStorage.getItem(LS_CLIENT);
    if (!cid) {
      cid = `${now}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(LS_CLIENT, cid);
    }
    return cid;
  } catch {
    return `cid-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export default function App() {
  /* =========================
     ローカル状態 & 設定
     ========================= */
  const [inventory, setInventory] = useState<Inventory>(() => {
    try {
      const raw = localStorage.getItem(LS_INV);
      return raw ? JSON.parse(raw) : INITIAL_INVENTORY;
    } catch {
      return INITIAL_INVENTORY;
    }
  });
  const [baseline, setBaseline] = useState<Baseline>(() => {
    try {
      const raw = localStorage.getItem(LS_BASE);
      return raw ? JSON.parse(raw) : INITIAL_INVENTORY;
    } catch {
      return INITIAL_INVENTORY;
    }
  });
  const [counts, setCounts] = useState<Counts>(() => {
    try {
      const raw = localStorage.getItem(LS_COUNTS);
      if (raw) return JSON.parse(raw);
    } catch {}
    const o: Counts = {};
    (Object.keys(RECIPES) as string[]).forEach((k) => (o[k] = 0));
    return o;
  });

  /* —— 在庫編集：ドラフト方式 —— */
  const [isEditingStock, setIsEditingStock] = useState(false);     // 在庫編集モード（ON で編集UI表示）
  const [draftInventory, setDraftInventory] = useState<Inventory | null>(null); // 編集中だけ保持
  // 入力UIは draftInventory を表示し、適用時に setInventory へ反映する

  /* バージョン（ローカルの観測版。CASの期待値にも使用） */
  const [version, setVersion] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(LS_VER) || "0") || 0;
    } catch {
      return 0;
    }
  });

  /* 接続情報 */
  const [sbUrl, setSbUrl] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_SYNC) || "{}").url || "";
    } catch {
      return "";
    }
  });
  const [sbKey, setSbKey] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_SYNC) || "{}").key || "";
    } catch {
      return "";
    }
  });
  const [roomId, setRoomId] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_SYNC) || "{}").room || "";
    } catch {
      return "";
    }
  });

  const [connected, setConnected] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_AUTOCONN) === "1";
    } catch {
      return false;
    }
  });

  /* 参照＆内部制御 */
  const supabaseRef = useRef<any>(null);
  const versionRef = useRef<number>(0);
  const subscriptionRef = useRef<any>(null);
  const applyTimerRef = useRef<any>(null);

  const remoteApplyingRef = useRef(false); // Realtime反映ループ抑止
  const localDirtyRef = useRef(false);     // 直近のローカル操作が未送信

  /* =========================
     早出しロック（busy）制御
     ========================= */
  const LOCK_TTL_MS = 1000; // 1秒ロック
  const lockUntilRef = useRef<number>(0);
  const [lockActive, setLockActive] = useState(false);
  const lockTimerRef = useRef<any>(null);
  const lastBusyOwnerRef = useRef<string | null>(null);
  const lastBusyStartedRef = useRef<number>(0);

  // 自分の早出しロックはUIを止めない。他端末のbusyのみブロック。
  const actionsBlocked = () => lockActive;

  const markLockedUntil = (until: number) => {
    lockUntilRef.current = until;
    setLockActive(true);
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    const delay = Math.max(0, until - Date.now());
    lockTimerRef.current = setTimeout(() => {
      setLockActive(false);
    }, delay + 50);
  };

  /* =========================
     小ポップ / 失敗モーダル
     ========================= */
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string>("");
  const syncTimerRef = useRef<any>(null);
  const [showRetryModal, setShowRetryModal] = useState(false);

  const startSync = (msg: string, ms = 1000) => {
    setSyncMsg(msg);
    setSyncBusy(true);
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => setSyncBusy(false), ms);
  };
  const finishSync = () => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => setSyncBusy(false), 150);
  };

  /* =========================
     オンデマンドpull（軽量）
     ========================= */
  const scheduleOneShotPull = (ms: number) => {
    if (!connected || !supabaseRef.current || !roomId) return;
    setTimeout(async () => {
      try {
        const { data } = await supabaseRef.current
          .from("rooms")
          .select("payload")
          .eq("id", roomId)
          .maybeSingle();
        const r = data?.payload as RemotePayload | undefined;
        if (r && Number(r.version || 0) > Number(versionRef.current || 0)) {
          remoteApplyingRef.current = true;
          setInventory(r.inventory);
          setBaseline(r.baseline);
          setCounts(r.counts);
          setVersion(Number(r.version || 0));
        }
      } catch {}
    }, ms);
  };

  /* =========================
     スクロール位置の保存/復元
     ========================= */
  const SCROLL_KEY = "mt_scrollY";
  const reloadWithScrollSave = () => {
    try {
      sessionStorage.setItem(SCROLL_KEY, String(window.scrollY || 0));
    } catch {}
    window.location.reload();
  };
  useEffect(() => {
    try {
      const y = Number(sessionStorage.getItem(SCROLL_KEY) || "NaN");
      if (Number.isFinite(y)) {
        sessionStorage.removeItem(SCROLL_KEY);
        setTimeout(() => window.scrollTo(0, y), 0);
      }
    } catch {}
  }, []);

  /* =========================
     ローカル永続化
     ========================= */
  useEffect(() => {
    localStorage.setItem(LS_INV, JSON.stringify(inventory));
  }, [inventory]);
  useEffect(() => {
    localStorage.setItem(LS_BASE, JSON.stringify(baseline));
  }, [baseline]);
  useEffect(() => {
    localStorage.setItem(LS_COUNTS, JSON.stringify(counts));
  }, [counts]);
  useEffect(() => {
    localStorage.setItem(LS_VER, String(version));
    versionRef.current = version;
  }, [version]);
  useEffect(() => {
    localStorage.setItem(
      LS_SYNC,
      JSON.stringify({ url: sbUrl, key: sbKey, room: roomId })
    );
  }, [sbUrl, sbKey, roomId]);

  /* =========================
     在庫編集（ドラフトユーティリティ）
     ========================= */
  const beginStockEdit = () => {
    // 最新の在庫を下敷きに編集開始（サーバ最新が欲しければ先に接続/再読み込みでpull）
    setDraftInventory(inventory);
    setIsEditingStock(true);
  };
  const cancelStockEdit = () => {
    setIsEditingStock(false);
    setDraftInventory(null);
  };

  // ドラフトに値をセット
  const setDraftInventoryValue = (key: keyof Inventory, val: number) => {
    setDraftInventory((prev) => {
      const base = prev ?? inventory;
      const next = { ...base } as Inventory;
      (next as any)[key] = Math.max(0, Number.isFinite(val) ? val : 0);
      return next;
    });
  };
  // ドラフトを増減
  const bumpDraftInventory = (key: keyof Inventory, delta: number) => {
    setDraftInventory((prev) => {
      const base = prev ?? inventory;
      const cur = (base as any)[key] as number;
      const nextVal = Math.max(0, cur + delta);
      const next = { ...base } as Inventory;
      (next as any)[key] = nextVal;
      return next;
    });
  };

  // 適用：busy早出し → ドラフトを本番へ反映（baseline も必要に応じて更新）→ push
  const applyStockEdit = async () => {
    if (!draftInventory) return;
    // 事前に他端末busyなら弾く
    if (!(await preflightOrBlock())) return;

    // 接続中はbusyを立ててから確定（“確定後反映”）
    if (connected) {
      await earlyAnnounce();
      await awaitBusyEcho();
    }

    // 実在庫・基準を更新（基準は「補充時に上書き」ルールを維持）
    setInventory((prev) => {
      const next = { ...(draftInventory as Inventory) };
      // baselineは「増えた項目のみ上書き」
      setBaseline((prevBase) => {
        const b: any = { ...(prevBase as Baseline) };
        (Object.keys(next) as (keyof Inventory)[]).forEach((k) => {
          const prevVal = (prevBase as any)[k] ?? 0;
          const nowVal = (next as any)[k] ?? 0;
          if (nowVal > prevVal) b[k] = nowVal;
        });
        return b as Baseline;
      });
      return next as Inventory;
    });

    // この変更を送るフラグ
    localDirtyRef.current = true;

    // UIを通常モードへ
    setIsEditingStock(false);
    setDraftInventory(null);
    startSync("在庫編集を適用中…", 900);
  };

  /* =========================
     ヘルパー（在庫/可否/原価）
     ========================= */
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

  /* =========================
     同期（busy早出し + CAS）
     ========================= */
  const clientId = useRef<string>(ensureClientId());
  const pushingRef = useRef(false);        // 自分が本送信中か（UI反映制御）
  const earlyAnnouncedRef = useRef(false); // 早出しbusyを連発しないためのフラグ

  type RemotePayload = {
    inventory: Inventory;
    baseline: Baseline;
    counts: Counts;
    version: number;
    updated_at: string;
    sync?: { busy: boolean; owner: string; started_at: number };
  };

  const buildPayload = (partial?: Partial<RemotePayload>): RemotePayload => ({
    inventory,
    baseline,
    counts,
    version,
    updated_at: new Date().toISOString(),
    sync: { busy: false, owner: clientId.current, started_at: Date.now() },
    ...(partial || {}),
  });

  // 自分の「早出し busy 告知」：見た目のロック＆他端末ブロック。自端末は止めない
  const earlyAnnounce = async () => {
    if (!connected || !supabaseRef.current || !roomId || earlyAnnouncedRef.current)
      return;
    earlyAnnouncedRef.current = true;
    startSync("同期中…", 1000); // 小ポップ（1秒）
    const sb = supabaseRef.current;
    const announce = buildPayload({
      sync: { busy: true, owner: clientId.current, started_at: Date.now() },
    });
    await sb
      .from("rooms")
      .upsert({ id: roomId, payload: announce }, { onConflict: "id" });
  };

  // 自分のbusyがDB側に反映されたか軽く確認（確定後反映の見え方用）
  const awaitBusyEcho = async (timeoutMs = 800, intervalMs = 80) => {
    if (!connected || !supabaseRef.current || !roomId) return true;
    const sb = supabaseRef.current;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { data } = await sb
        .from("rooms")
        .select("payload")
        .eq("id", roomId)
        .maybeSingle();
      const remote = data?.payload as RemotePayload | undefined;
      if (remote?.sync?.busy && remote.sync.owner === clientId.current) return true;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  };

  // 押下直前のプリフライト：他端末busyなら弾く（モーダル＋TTL後の軽pull）
  const preflightOrBlock = async (): Promise<boolean> => {
    if (!connected || !supabaseRef.current || !roomId) return true;
    if (lockActive) return false;
    const sb = supabaseRef.current;
    const { data } = await sb
      .from("rooms")
      .select("payload")
      .eq("id", roomId)
      .maybeSingle();
    const remote = data?.payload as RemotePayload | undefined;
    if (remote?.sync?.busy && remote.sync.owner !== clientId.current) {
      const started = Number(remote.sync.started_at || 0);
      const until = started + LOCK_TTL_MS;
      markLockedUntil(until);
      startSync("同期中…", Math.max(600, until - Date.now()));
      setShowRetryModal(true);
      scheduleOneShotPull(Math.max(0, until - Date.now()) + 120);
      return false;
    }
    return true;
  };

  /* =========================
     アクション（接続中は busy確定→UI反映）
     ========================= */
  const makeOne = async (recipeKey: string) => {
    if (!(await preflightOrBlock())) return;
    if (connected) {
      await earlyAnnounce();
      await awaitBusyEcho();
    }
    localDirtyRef.current = true;
    const check = canMake(recipeKey);
    if (!check.ok || actionsBlocked()) return;
    const recipe = RECIPES[recipeKey];
    setInventory((prev: Inventory) => {
      const next: Inventory = { ...prev } as Inventory;
      for (const k in recipe)
        (next as any)[k] = Math.max(0, ((next as any)[k] as number) - recipe[k]);
      return next;
    });
    setCounts((prev: Counts) => ({
      ...prev,
      [recipeKey]: (prev[recipeKey] || 0) + 1,
    }));
  };

  const undoOne = async (recipeKey: string) => {
    if (!(await preflightOrBlock())) return;
    if (connected) {
      await earlyAnnounce();
      await awaitBusyEcho();
    }
    localDirtyRef.current = true;
    if (actionsBlocked()) return;
    setCounts((prev: Counts) => {
      const cur = prev[recipeKey] || 0;
      if (cur <= 0) return prev;
      return { ...prev, [recipeKey]: cur - 1 };
    });
    const recipe = RECIPES[recipeKey];
    setInventory((prev: Inventory) => {
      const next: Inventory = { ...prev } as Inventory;
      for (const k in recipe)
        (next as any)[k] = Math.max(0, ((next as any)[k] as number) + recipe[k]);
      return next;
    });
  };

  const resetAll = async () => {
    if (!(await preflightOrBlock())) return;
    if (connected) {
      await earlyAnnounce();
      await awaitBusyEcho();
    }
    localDirtyRef.current = true;
    if (actionsBlocked()) return;
    setInventory(INITIAL_INVENTORY);
    setBaseline(INITIAL_INVENTORY);
    const o: Counts = {};
    (Object.keys(RECIPES) as string[]).forEach((k) => (o[k] = 0));
    setCounts(o);
  };

  /* =========================
     派生表示・集計
     ========================= */
  // 表示用に「現在表示する在庫」を一本化
  const displayInventory: Inventory = (isEditingStock && draftInventory) ? draftInventory : inventory;

  const inventoryList = useMemo<{ key: string; label: string; value: number }[]>(
    () =>
      Object.entries(displayInventory).map(([k, v]) => ({
        key: k,
        label: NICE_LABEL[k as keyof typeof NICE_LABEL] || k,
        value: v as number,
      })),
    [displayInventory]
  );

  const servingsMap = useMemo(() => {
    const out: Record<string, number> = {};
    for (const key of Object.keys(RECIPES) as string[])
      out[key] = servingsLeftWith(displayInventory as Inventory, key);
    return out;
  }, [displayInventory]);

  const getLevel = (key: keyof Inventory, value: number) => {
    const base = (baseline as any)[key] as number | undefined;
    if (!Number.isFinite(base) || (base as number) <= 0) return "ok";
    const pct = value / (base as number);
    if (pct <= 0.15) return "danger";
    if (pct <= 0.35) return "warn";
    return "ok";
  };

  const perCupCost = useMemo(() => {
    const map: Record<string, number> = {};
    for (const key of Object.keys(RECIPES) as string[]) {
      if (PER_RECIPE_COSTS[key] != null) {
        map[key] = Math.round(PER_RECIPE_COSTS[key] * 10) / 10;
        continue;
      }
      const recipe = RECIPES[key];
      let cost = 0;
      for (const mat in recipe) {
        const amt = recipe[mat];
        cost +=
          mat === "peach_pieces"
            ? PEACH_GARNISH_COST * amt
            : ((UNIT_COSTS as any)[mat] || 0) * amt;
      }
      map[key] = Math.round(cost * 10) / 10;
    }
    return map;
  }, []);

  const totals = useMemo(() => {
    let cups = 0,
      cogs = 0;
    for (const k of Object.keys(counts)) {
      const n = counts[k] || 0;
      cups += n;
      cogs += n * (perCupCost[k] || 0);
    }
    const revenue = cups * PRICE_PER_CUP;
    const gp = revenue - cogs;
    const margin = revenue > 0 ? gp / revenue : 0;
    return { cups, revenue, cogs: Math.round(cogs), gp: Math.round(gp), margin };
  }, [counts, perCupCost]);

  /* =========================
     Supabase接続・購読
     ========================= */

  const clearAutoConn = () => {
    try {
      localStorage.removeItem(LS_AUTOCONN);
    } catch {}
    setConnected(false);
  };

  const setAutoConnOn = () => {
    try {
      localStorage.setItem(LS_AUTOCONN, "1");
    } catch {}
  };

  // 最新スナップショットを強制取得（force=true: ローカルより古くても上書き）
  const pullLatest = async (force = false) => {
    if (!supabaseRef.current || !roomId) return false;
    try {
      const { data } = await supabaseRef.current
        .from("rooms")
        .select("payload")
        .eq("id", roomId)
        .maybeSingle();
      const r = data?.payload as RemotePayload | undefined;
      const remoteVer = Number(r?.version || 0);
      const localVer = Number(versionRef.current || 0);
      if (r && (force || remoteVer > localVer)) {
        remoteApplyingRef.current = true;
        setInventory(r.inventory);
        setBaseline(r.baseline);
        setCounts(r.counts);
        setVersion(remoteVer);
        // 編集中は表示が draft 優先のため、ここでは draft は維持（あえて上書きしない）
        return true;
      }
    } catch (e) {
      console.error("pullLatest error", e);
    }
    return false;
  };

  const handleReload = async () => {
    startSync("最新を取得中…", 800);
    if (connected) {
      await pullLatest(true); // サーバ最新で上書き
    }
    reloadWithScrollSave();
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
        alert("Supabase URL / anon key / Room ID を入力してください");
        clearAutoConn();
        return false;
      }

      const sb = cc(sbUrl, sbKey);
      supabaseRef.current = sb;
      setConnected(true);
      startSync("接続中…", 800);

      // 初回スナップショット作成 or 取得
      const { data: got } = await sb
        .from("rooms")
        .select("id,payload")
        .eq("id", roomId)
        .maybeSingle();
      if (got && (got as any).payload) {
        const remote = (got as any).payload as RemotePayload;
        const remoteVer = Number(remote?.version || 0);
        if (remoteVer > version) {
          setInventory(remote.inventory);
          setBaseline(remote.baseline);
          setCounts(remote.counts);
          setVersion(remoteVer);
        }
      } else {
        await sb.from("rooms").upsert({ id: roomId, payload: buildPayload() }, { onConflict: "id" });
      }

      // Postgres Changes 購読
      if (subscriptionRef.current) sb.removeChannel(subscriptionRef.current);
      const handler = (ev: any) => {
        try {
          const remote = ev?.new?.payload as RemotePayload;
          if (!remote) return;

          // 他端末busyの受信 → TTLまでボタンブロック
          const busy = !!remote?.sync?.busy;
          const owner = remote?.sync?.owner;
          const started = Number(remote?.sync?.started_at || 0);
          if (busy && owner && owner !== clientId.current) {
            const isNewBusy =
              owner !== lastBusyOwnerRef.current || started > lastBusyStartedRef.current;
            if (isNewBusy) {
              lastBusyOwnerRef.current = owner;
              lastBusyStartedRef.current = started;
              const until = started + LOCK_TTL_MS;
              if (until > Date.now()) markLockedUntil(until);
              const remain = Math.max(0, until - Date.now());
              startSync("同期中…", Math.max(remain, 600));
            }
          }

          // 新しい版のみを取り込む
          const remoteVer = Number(remote?.version || 0);
          if (pushingRef.current) return; // 自分の本送信中は無視
          if (remoteVer <= Number(versionRef.current || 0)) return;

          if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
          applyTimerRef.current = setTimeout(() => {
            remoteApplyingRef.current = true;
            setInventory(remote.inventory);
            setBaseline(remote.baseline);
            setCounts(remote.counts);
            setVersion(remoteVer);
          }, 100);
        } catch {}
      };
      const channel = sb
        .channel(`rooms:${roomId}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
          handler
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "rooms", filter: `id=eq.${roomId}` },
          handler
        )
        .subscribe();
      subscriptionRef.current = channel;

      // 接続直後に「必ず」サーバ最新を強制取得
      await pullLatest(true);

      setAutoConnOn();
      finishSync();
      return true;
    } catch (e) {
      console.error(e);
      clearAutoConn();
      return false;
    }
  };

  /* =========================
     変更時 push（CAS + busy解除）
     ========================= */
  useEffect(() => {
    const push = async () => {
      if (!connected || !supabaseRef.current || !roomId) return;
      if (remoteApplyingRef.current) { remoteApplyingRef.current = false; return; }
      if (!localDirtyRef.current) return;

      const sb = supabaseRef.current;

      // 他端末 busy 中は待つ
      const { data } = await sb.from("rooms").select("payload").eq("id", roomId).maybeSingle();
      const remote = data?.payload as RemotePayload | undefined;
      if (remote?.sync?.busy && remote.sync.owner !== clientId.current) {
        const started = Number(remote.sync.started_at || 0);
        const until = started + LOCK_TTL_MS;
        const delay = Math.max(0, until - Date.now()) + 200;
        markLockedUntil(until);
        setTimeout(push, delay);
        return;
      }

      const expected = Number(version) || 0; // CASの期待版
      const nextVersion = expected + 1;

      // 本送信前だけ「同期中…」小ポップ
      pushingRef.current = true;
      startSync("同期中…", 1000);

      // busy告知（見た目/他端末ブロック用）
      const announce = buildPayload({
        sync: { busy: true, owner: clientId.current, started_at: Date.now() },
      });
      await sb.from("rooms").upsert({ id: roomId, payload: announce }, { onConflict: "id" });

      // 最終スナップショット（busy解除 + version++）
      const finalPayload = buildPayload({
        version: nextVersion,
        sync: { busy: false, owner: clientId.current, started_at: Date.now() },
      });

      // CAS（payload->>version が expected のときだけ更新）
      const { data: upd, error: casErr } = await sb
        .from("rooms")
        .update({ payload: finalPayload })
        .eq("id", roomId)
        .filter("payload->>version", "eq", String(expected))
        .select();

      if (casErr) {
        console.error("CAS update error", casErr);
        const { data: latest } = await sb
          .from("rooms")
          .select("payload")
          .eq("id", roomId)
          .maybeSingle();
        const r = latest?.payload as RemotePayload | undefined;
        if (r) {
          remoteApplyingRef.current = true;
          setInventory(r.inventory);
          setBaseline(r.baseline);
          setCounts(r.counts);
          setVersion(Number(r.version || 0));
        }
        localDirtyRef.current = false;
        setShowRetryModal(true);
        scheduleOneShotPull(200);
        setTimeout(() => {
          earlyAnnouncedRef.current = false;
          pushingRef.current = false;
          finishSync();
        }, 120);
        return;
      }

      if (!upd || upd.length === 0) {
        startSync("更新競合 → 最新を反映", 900);
        const { data: latest } = await sb
          .from("rooms")
          .select("payload")
          .eq("id", roomId)
          .maybeSingle();
        const r = latest?.payload as RemotePayload | undefined;
        if (r) {
          remoteApplyingRef.current = true;
          setInventory(r.inventory);
          setBaseline(r.baseline);
          setCounts(r.counts);
          setVersion(Number(r.version || 0));
        }
        localDirtyRef.current = false;
        setShowRetryModal(true);
        scheduleOneShotPull(200);
        setTimeout(() => {
          earlyAnnouncedRef.current = false;
          pushingRef.current = false;
          finishSync();
        }, 120);
        return;
      }

      // CAS成功
      setVersion(nextVersion);
      localDirtyRef.current = false;
      setTimeout(() => {
        earlyAnnouncedRef.current = false;
        pushingRef.current = false;
        finishSync();
      }, 120);
    };
    push();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory, baseline, counts]);

  /* =========================
     自動再接続
     ========================= */
  useEffect(() => {
    const auto = (() => {
      try {
        return localStorage.getItem(LS_AUTOCONN) === "1";
      } catch {
        return false;
      }
    })();
    const hasCreds = !!(sbUrl && sbKey && roomId);
    if (auto && hasCreds) {
      setConnected(true);
      const t = setTimeout(() => {
        connectSupabase().then((ok) => {
          if (!ok) clearAutoConn();
        });
      }, 120);
      return () => clearTimeout(t);
    } else {
      clearAutoConn();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* =========================
     デバッグ用: クイック検証
     ========================= */
  useEffect(() => {
    const results: { name: string; pass: boolean; got: any; expected: any }[] = [];
    const eq = (name: string, got: any, expected: any) =>
      results.push({ name, pass: Object.is(got, expected), got, expected });
    eq("白桃さっぱり max", servingsLeftWith(INITIAL_INVENTORY as any, "白桃スカッシュ / さっぱり"), 40);
    eq("モヒート甘め max", servingsLeftWith(INITIAL_INVENTORY as any, "パインモヒート / 甘め"), 35);
    eq("トロピカルすっきり max", servingsLeftWith(INITIAL_INVENTORY as any, "トロピカルスカッシュ / すっきり"), 30);
    const invNoPeach = { ...INITIAL_INVENTORY, peach_pieces: 0 } as typeof INITIAL_INVENTORY;
    eq("白桃トッピング不足検出", canMakeWith(invNoPeach as Inventory, "白桃スカッシュ / さっぱり").ok, false);
    console.table(results);
  }, []);

  /* =========================
     UI
     ========================= */
  return (
    <>
      <div className="min-h-screen bg-neutral-50 text-neutral-900 p-6">
        <div className="max-w-6xl mx-auto">
          <header className="flex items-start justify-between gap-4 mb-6">
            <div>
              <h1 className="text-2xl font-bold">モクテル在庫トラッカー</h1>
              <p className="text-sm text-neutral-600">
                在庫を減算・補充して各端末で同期。Room ID を共有すると複数端末で同じ在庫を見られます。
              </p>
            </div>
            <div className="flex items-center gap-2">
              {/* 在庫編集：押すと編集モードに入る（トグルOFFは廃止） */}
              <button
                onClick={beginStockEdit}
                className="px-4 py-2 rounded-2xl shadow bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
                disabled={isEditingStock}
                title="在庫値を編集します（適用するまで他端末へは反映されません）"
              >
                在庫編集
              </button>

              {/* 最新取得 → 再読み込み */}
              <button
                onClick={handleReload}
                className="px-3 py-2 rounded-2xl bg-white hover:bg-neutral-100 text-neutral-900 border border-neutral-200 shadow"
                title="最新取得→ページ再読み込み"
              >
                再読み込み
              </button>

              {/* 在庫全リセット（従来どおり即時反映/同期） */}
              <button
                onClick={resetAll}
                className="px-4 py-2 rounded-2xl bg-neutral-900 text-white hover:bg-neutral-800 shadow"
                disabled={actionsBlocked()}
              >
                リセット
              </button>
            </div>
          </header>

          {/* 同期設定 */}
          <section className="mb-6">
            <div className="bg-white rounded-2xl shadow p-4 grid md:grid-cols-4 gap-2 text-sm">
              <input
                className="px-2 py-2 rounded border"
                placeholder="Supabase URL"
                value={sbUrl}
                onChange={(e) => setSbUrl(e.target.value)}
              />
              <input
                className="px-2 py-2 rounded border"
                placeholder="Supabase anon key"
                value={sbKey}
                onChange={(e) => setSbKey(e.target.value)}
              />
              <input
                className="px-2 py-2 rounded border"
                placeholder="Room ID（英数・長め推奨）"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
              />
              <button
                className={`px-4 py-2 rounded ${connected ? "bg-emerald-600 text-white" : "bg-neutral-900 text-white"}`}
                onClick={connectSupabase}
              >
                {connected ? "接続中" : "接続"}
              </button>
            </div>
            <p className="text-xs text-neutral-500 mt-1">
              ※ 接続中は、同時押しでもCASで一貫性を担保。再読み込み/接続直後はサーバの最新を取得します。
            </p>
          </section>

          {/* サマリー */}
          <section className="mb-6">
            <div className="grid md:grid-cols-4 gap-2 text-sm">
              <div className="bg-white rounded-xl p-3 shadow flex justify-between">
                <span>売価(1杯)</span>
                <span className="font-mono">¥{PRICE_PER_CUP}</span>
              </div>
              <div className="bg-white rounded-xl p-3 shadow flex justify-between">
                <span>合計杯数</span>
                <span className="font-mono">{totals.cups}</span>
              </div>
              <div className="bg-white rounded-xl p-3 shadow flex justify-between">
                <span>売上</span>
                <span className="font-mono">¥{totals.revenue}</span>
              </div>
              <div className="bg-white rounded-xl p-3 shadow flex justify-between">
                <span>合計原価</span>
                <span className="font-mono">¥{totals.cogs}</span>
              </div>
            </div>
          </section>

          {/* バリエーション一覧（作る/戻すは従来のまま = 即時反映→同期） */}
          <section className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {(Object.keys(RECIPES) as string[]).map((key) => {
              const invForCheck = displayInventory; // 表示在庫に基づく可否（編集中はドラフト参照）
              const { ok, blockers } = canMakeWith(invForCheck, key);
              const left = servingsMap[key];
              const disabledMake = !ok || actionsBlocked();
              const disabledUndo = (counts[key] || 0) === 0 || actionsBlocked();
              return (
                <div key={key} className="bg-white rounded-2xl shadow p-4 flex flex-col gap-3">
                  <div>
                    <h2 className="font-semibold text-lg">{key}</h2>
                    <p className="text-xs text-neutral-500">
                      作成数: <span className="font-mono">{counts[key] || 0}</span> / 可能:{" "}
                      <span className="font-mono">{left}</span> 杯 / 1杯原価: <span className="font-mono">¥{perCupCost[key]}</span>
                    </p>
                  </div>

                  <div className="text-xs bg-neutral-50 rounded-xl p-3">
                    <p className="text-neutral-500 mb-1">1杯あたりの使用量</p>
                    <ul className="grid grid-cols-2 gap-1">
                      {(Object.entries(RECIPES[key]) as [string, number][])?.map(([ik, amount]) => (
                        <li key={ik} className="flex items-center justify-between">
                          <span>{NICE_LABEL[ik as keyof typeof NICE_LABEL] || ik}</span>
                          <span className="font-mono">
                            {amount}
                            {ik === "peach_pieces" ? "個" : "ml"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="mt-auto flex gap-2">
                    <button
                      onClick={() => makeOne(key)}
                      disabled={disabledMake || isEditingStock} // 編集中は誤操作防止で無効化
                      className={`px-4 py-2 rounded-xl font-medium shadow transition ${
                        (disabledMake || isEditingStock)
                          ? "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                          : "bg-emerald-600 hover:bg-emerald-700 text-white"
                      }`}
                    >
                      1杯作る
                    </button>
                    <button
                      onClick={() => undoOne(key)}
                      disabled={disabledUndo || isEditingStock}
                      className={`px-4 py-2 rounded-xl font-medium shadow transition ${
                        (disabledUndo || isEditingStock)
                          ? "bg-neutral-200 text-neutral-500 cursor-not-allowed"
                          : "bg-red-600 hover:bg-red-700 text-white"
                      }`}
                      title="直前の誤操作などを取り消して1杯分を在庫に戻します"
                    >
                      1杯減らす
                    </button>
                  </div>

                  {!ok && <div className="text-xs text-red-600">在庫不足：{blockers.join("・")}</div>}
                </div>
              );
            })}
          </section>

          {/* 在庫サマリー（編集中はドラフトを表示&編集） */}
          <section className="mt-8 relative">
            <h3 className="font-semibold mb-3">在庫（残量）</h3>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
              {inventoryList.map(({ key, label, value }) => {
                const isPieces = key === "peach_pieces";
                const level = getLevel(key as keyof Inventory, value as number);
                const base = (baseline as any)[key] ?? 0;
                const pct = base > 0 ? Math.min(1, Math.max(0, (value as number) / base)) : 1;
                const wrapCls =
                  level === "danger"
                    ? "border border-red-300 bg-red-50"
                    : level === "warn"
                    ? "border border-amber-300 bg-amber-50"
                    : "border border-neutral-200 bg-white";
                return (
                  <div
                    key={key}
                    className={`${wrapCls} rounded-xl p-3 shadow text-sm flex flex-col gap-2`}
                  >
                    <div className="flex items-center justify-between">
                      <span>{label}</span>
                      <span
                        className={`font-mono ${
                          level === "danger"
                            ? "text-red-700"
                            : level === "warn"
                            ? "text-amber-700"
                            : "text-neutral-900"
                        }`}
                      >
                        {value}
                        {isPieces ? "個" : "ml"}
                      </span>
                    </div>
                    {base > 0 && (
                      <div className="h-2 w-full rounded bg-neutral-100 overflow-hidden">
                        <div
                          className={`${
                            level === "danger"
                              ? "bg-red-500"
                              : level === "warn"
                              ? "bg-amber-500"
                              : "bg-emerald-500"
                          } h-full`}
                          style={{ width: `${pct * 100}%` }}
                          aria-hidden
                        />
                      </div>
                    )}

                    {/* 編集UI：ドラフトにだけ反映（適用するまで他端末へ影響なし） */}
                    {isEditingStock && (
                      <div className="flex items-center gap-2 mt-1">
                        <input
                          type="number"
                          inputMode="numeric"
                          className="w-28 px-2 py-1 rounded border border-neutral-300 font-mono"
                          value={value as number}
                          onChange={(e) =>
                            setDraftInventoryValue(key as keyof Inventory, Number(e.target.value))
                          }
                        />
                        <div className="flex gap-1">
                          {isPieces ? (
                            <>
                              <button
                                className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200"
                                onClick={() => bumpDraftInventory(key as keyof Inventory, 1)}
                              >
                                +1
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200"
                                onClick={() => bumpDraftInventory(key as keyof Inventory, 5)}
                              >
                                +5
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200"
                                onClick={() => bumpDraftInventory(key as keyof Inventory, 10)}
                              >
                                +10
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200"
                                onClick={() => bumpDraftInventory(key as keyof Inventory, 50)}
                              >
                                +50
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200"
                                onClick={() => bumpDraftInventory(key as keyof Inventory, 100)}
                              >
                                +100
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-neutral-100 hover:bg-neutral-200"
                                onClick={() => bumpDraftInventory(key as keyof Inventory, 500)}
                              >
                                +500
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 編集中のみ：右下に適用/キャンセル */}
            {isEditingStock && (
              <div className="mt-4 flex gap-2 justify-end">
                <button
                  onClick={cancelStockEdit}
                  className="px-4 py-2 rounded-xl bg-white border border-neutral-300 hover:bg-neutral-100 shadow text-neutral-700"
                >
                  キャンセル
                </button>
                <button
                  onClick={applyStockEdit}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shadow disabled:opacity-50"
                  disabled={actionsBlocked()}
                  title="ドラフト在庫を全端末へ反映（サーバへコミット）"
                >
                  適用
                </button>
              </div>
            )}

            <p className="text-xs text-neutral-500 mt-2">
              ※ 在庫編集は「適用」するまで他端末に反映されません。適用時に最新へ同期します。
            </p>
          </section>

          {/* 小ポップ（画面上部に1秒） */}
          {syncBusy && (
            <div className="fixed inset-0 pointer-events-none flex items-start justify-center">
              <div className="mt-10 px-4 py-2 rounded-xl shadow bg-neutral-900/90 text-white text-sm flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                <span>{syncMsg || "同期中…"}</span>
              </div>
            </div>
          )}

          {/* 送信失敗モーダル（中央） */}
          {showRetryModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="w-[92%] max-w-md rounded-2xl bg-white shadow-xl p-6 text-center">
                <h3 className="text-base font-semibold text-neutral-900 mb-2">送信できませんでした</h3>
                <p className="text-sm text-neutral-600">もう一度お試しください。</p>
                <div className="mt-5">
                  <button
                    onClick={() => setShowRetryModal(false)}
                    className="inline-flex items-center justify-center rounded-xl bg-neutral-900 text-white px-4 py-2 hover:bg-neutral-800 shadow"
                  >
                    OK
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
