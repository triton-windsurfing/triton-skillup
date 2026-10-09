/* Triton スキルアップ — 会員・インストラクター用アプリ
 * LINEミニアプリ（LIFF）でログインし、Supabaseにデータを保存する。
 * URLに ?demo を付けると、サンプルデータで画面だけ確認できる（保存はされない）。
 */
(() => {
  "use strict";

  const C = window.APP_CONFIG;
  const DEMO = new URLSearchParams(location.search).has("demo");
  const $app = document.getElementById("app");
  const BADGES = [
    { lv: 3, name: "初級<br>卒業" },
    { lv: 5, name: "中級<br>認定" },
    { lv: 7, name: "上級<br>認定" },
    { lv: 9, name: "エキスパート<br>認定" },
    { lv: 10, name: "プロ<br>認定" },
  ];

  // ---------- 小さな道具 ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const todayJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const fmtDate = (d) => {
    if (!d) return "—";
    const [y, m, dd] = d.split("-").map(Number);
    const wd = "日月火水木金土"[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
    return `${m}/${dd}（${wd}）`;
  };
  const daysSince = (d) => (d ? Math.round((Date.parse(todayJST()) - Date.parse(d)) / 86400e3) : null);
  const nameOf = (m) => (m && (m.display_name || m.line_name)) || "名前未設定";
  const roleLabel = { member: "会員", instructor: "インストラクター", admin: "管理者" };
  const isStaff = (m) => m && (m.role === "instructor" || m.role === "admin");
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動く */ } },
  };
  const ICON = {
    check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    lock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    home: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
    flag: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>',
    list: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    staff: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.5 2.4 3.5 5.2"/></svg>',
    tool: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6.5a4 4 0 0 0-5.2 5.2L3 18l3 3 6.3-6.3a4 4 0 0 0 5.2-5.2l-2.7 2.7-2.3-.7-.7-2.3z"/></svg>',
  };

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------- データの出し入れ（本番：Supabase） ----------
  function realApi() {
    let sb;
    const loginOnce = "triton-login-retry";
    async function loginWithLine() {
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return new Promise(() => {}); // LINEのログイン画面へ移動する
      }
      // 名前とプロフィール写真の利用許可がまだなら、ここで許可画面を出す
      try {
        const p = await liff.permission.query("profile");
        if (p.state === "prompt") await liff.permission.requestAll();
      } catch { /* 許可画面が使えない環境では名前なしで続ける */ }
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの情報を取得できませんでした。");
      const r = await fetch(`${C.supabaseUrl}/functions/v1/line-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, accessToken: liff.getAccessToken() }),
      });
      if (r.status === 401 && !sessionStorage.getItem(loginOnce)) {
        // LINE側のログイン情報が古い場合は一度だけやり直す
        sessionStorage.setItem(loginOnce, "1");
        liff.logout();
        liff.login({ redirectUri: location.href });
        return new Promise(() => {});
      }
      if (!r.ok) throw new Error(`ログインできませんでした（${r.status}）。`);
      sessionStorage.removeItem(loginOnce);
      const t = await r.json();
      const { error } = await sb.auth.setSession(t);
      if (error) throw error;
    }
    const uid = async () => (await sb.auth.getSession()).data.session?.user?.id;
    const ok = ({ data, error }) => { if (error) throw error; return data; };
    return {
      async boot() {
        sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, {
          auth: { persistSession: true, autoRefreshToken: true, storageKey: "triton-auth", detectSessionInUrl: false },
        });
        try {
          await Promise.race([
            liff.init({ liffId: C.liffId }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
          ]);
        } catch (e) {
          throw new Error(`LINEとの接続を始められませんでした（${(e && (e.code || e.message)) || "不明"}）。`);
        }
        if (!(await uid())) await loginWithLine();
        try {
          const me = await this.me();
          // LINEの名前がまだ入っていなければ、最新のLINE情報で入り直して名前と写真を反映する
          if (!me.line_name && liff.isLoggedIn() && liff.getIDToken()) {
            try { await loginWithLine(); return await this.me(); } catch { /* 名前がなくても使える */ }
          }
          return me;
        } catch (e) {
          // 保存されていたログイン状態が使えない場合はLINEで入り直す
          await sb.auth.signOut({ scope: "local" });
          await loginWithLine();
          return await this.me();
        }
      },
      async me() { return ok(await sb.from("members").select("*").eq("id", await uid()).single()); },
      async catalog() {
        const [levels, items] = await Promise.all([
          sb.from("skill_levels").select("*").order("track").order("level"),
          sb.from("skill_items").select("*").order("level").order("position"),
        ]);
        return { levels: ok(levels), items: ok(items) };
      },
      async checks(memberId) { return ok(await sb.from("skill_checks").select("*").eq("member_id", memberId)); },
      async lessons(memberId) {
        return ok(await sb.from("lessons").select("*").eq("member_id", memberId)
          .order("lesson_date", { ascending: false }).order("id", { ascending: false }).limit(200));
      },
      async member(id) { return ok(await sb.from("members").select("*").eq("id", id).single()); },
      async overview() { return ok(await sb.from("member_overview").select("*")); },
      async toggleSelf(itemId) { ok(await sb.rpc("toggle_self_check", { p_item_id: itemId })); },
      async setCertified(memberId, itemId, value) { ok(await sb.rpc("set_certified", { p_member_id: memberId, p_item_id: itemId, p_value: value })); },
      async recordLesson(memberId, comment, date) { ok(await sb.rpc("record_lesson", { p_member_id: memberId, p_comment: comment, p_date: date })); },
      async setGoal(n) { ok(await sb.rpc("set_monthly_goal", { p_goal: n })); },
      async updateMember(id, patch) { ok(await sb.from("members").update(patch).eq("id", id)); },
    };
  }

  // ---------- データの出し入れ（お試し表示：保存しない） ----------
  function demoApi() {
    const L = [
      ["basic",1,"超初心者","まずは風を感じる","#2E7D32","#FFFFFF",["ダガー付きボードで風上へ行ける","方向転換（タック）ができる","ランニングで走れる","ラフ／ベア"]],
      ["basic",2,"初心者","操作に慣れる","#8BC34A","#14263A",["ショートボードで風上へ行ける","タックができる","ジャイブができる"]],
      ["basic",3,"初級","ウィンドらしくなる","#F2C230","#14263A",["ビーチスタートができる","道具のセッティングができる","ハーネスをかけて走れる"]],
      ["basic",4,"初級〜中級","安定して乗れる","#F2A31B","#14263A",["中風域で風上へ行ける","ハーネスをかけて片手で走行","片足を水に浸けて走行"]],
      ["basic",5,"中級","スピードの世界へ","#EE7B30","#14263A",["強風域で風上へ行ける","プレーニングができる"]],
      ["basic",6,"中級〜上級","壁を越える","#1F6FB2","#FFFFFF",["ウォータースタートができる"]],
      ["basic",7,"上級","テクニックの領域","#2B5C9E","#FFFFFF",["レールジャイブ","ワンハンドでプレーニング","キックジャンプ"]],
      ["basic",8,"上級","自由度アップ","#5E55A6","#FFFFFF",["プレーニングから急停止","ハイジャンプ","プレーニングをキープしたままロングジャンプ"]],
      ["basic",9,"エキスパート","魅せるライディング","#C23B26","#FFFFFF",["プレーニングをキープしたままジャイブ","フロントサイドの技","MAX speed 50km/h以上出せる"]],
      ["basic",10,"プロ級","トップレベル","#1E2328","#FFFFFF",["一波で2回以上フロントサイドの技","ジャンプ系の技ができる","MAX speed 55km/h以上出せる"]],
      ["free",1,"入門トリック","フリースタイル Lv1","#2E7D32","#FFFFFF",["ヘリタック","セイル360","クリューファーストセイリング","ピボットジャイブ"]],
      ["free",2,"トリック","フリースタイル Lv2","#8BC34A","#14263A",["アップウインド360","プッシュタック","NPダックジャイブ","リワォード"]],
      ["free",3,"トリック","フリースタイル Lv3","#F2C230","#14263A",["クリューファーストヘリタック","テールファースト","セイルボディ360","ベンダー（風下回りの360）","ボード360（風上回り）"]],
    ];
    const levels = L.map(([track, level, grade, theme, color, fg]) => ({ track, level, grade, theme, color, fg }));
    const items = L.flatMap(([track, level, , , , , labels]) => labels.map((label, i) => ({ id: `${track}-${level}-${i}`, track, level, position: i, label })));
    const now = new Date().toISOString();
    const people = [
      { id: "d1", line_name: "お試し 管理者", display_name: null, role: "admin", sport: "wind", plan: "月会員", monthly_goal: 4, line_picture_url: null },
      { id: "d2", line_name: "海野 ナギサ", display_name: null, role: "member", sport: "wind", plan: "月会員", monthly_goal: 4, line_picture_url: null },
      { id: "d3", line_name: "浜田 ケン", display_name: null, role: "member", sport: "wind", plan: "回数券", monthly_goal: null, line_picture_url: null },
    ];
    const checks = [];
    const certAll = (mid, ids) => ids.forEach((id) => checks.push({ member_id: mid, item_id: id, self_checked_at: now, certified_at: now, certified_by: "d1" }));
    certAll("d1", items.filter((i) => i.track === "basic" && i.level <= 3).map((i) => i.id).concat(["basic-4-0", "free-1-0"]));
    checks.push({ member_id: "d1", item_id: "basic-4-1", self_checked_at: now, certified_at: null, certified_by: null });
    certAll("d2", items.filter((i) => i.track === "basic" && i.level <= 2).map((i) => i.id));
    checks.push({ member_id: "d2", item_id: "basic-3-0", self_checked_at: now, certified_at: null, certified_by: null });
    const t = todayJST();
    const lessons = [
      { id: 3, member_id: "d1", lesson_date: t, instructor_name: "お試し 講師", comment: "ハーネスに体重を預けられるようになってきました。次は片手走行に挑戦しましょう。" },
      { id: 2, member_id: "d1", lesson_date: "2026-09-28", instructor_name: "お試し 講師", comment: null },
      { id: 1, member_id: "d2", lesson_date: "2026-08-20", instructor_name: "お試し 講師", comment: "タックが安定してきました。" },
    ];
    let nextId = 10;
    const find = (mid, iid) => checks.find((c) => c.member_id === mid && c.item_id === iid);
    return {
      async boot() { return { ...people[0] }; },
      async me() { return { ...people[0] }; },
      async catalog() { return { levels, items }; },
      async checks(mid) { return checks.filter((c) => c.member_id === mid).map((c) => ({ ...c })); },
      async lessons(mid) { return lessons.filter((l) => l.member_id === mid).sort((a, b) => (b.lesson_date.localeCompare(a.lesson_date)) || b.id - a.id); },
      async member(id) { return { ...people.find((p) => p.id === id) }; },
      async overview() {
        return people.map((p) => {
          const ls = lessons.filter((l) => l.member_id === p.id);
          const cert = new Set(checks.filter((c) => c.member_id === p.id && c.certified_at).map((c) => c.item_id));
          const open = items.filter((i) => i.track === "basic" && !cert.has(i.id)).map((i) => i.level);
          return { ...p, lesson_count: ls.length, last_lesson_date: ls.map((l) => l.lesson_date).sort().pop() || null,
            waiting_count: checks.filter((c) => c.member_id === p.id && c.self_checked_at && !c.certified_at).length,
            current_level: open.length ? Math.min(...open) : 11 };
        });
      },
      async toggleSelf(iid) {
        const c = find("d1", iid);
        if (!c) checks.push({ member_id: "d1", item_id: iid, self_checked_at: now, certified_at: null, certified_by: null });
        else if (!c.certified_at) c.self_checked_at = c.self_checked_at ? null : now;
      },
      async setCertified(mid, iid, v) {
        let c = find(mid, iid);
        if (!c) { c = { member_id: mid, item_id: iid, self_checked_at: null }; checks.push(c); }
        c.certified_at = v ? (c.certified_at || now) : null;
        c.certified_by = v ? "d1" : null;
      },
      async recordLesson(mid, comment, date) { lessons.push({ id: nextId++, member_id: mid, lesson_date: date || t, instructor_name: "お試し 管理者", comment: comment || null }); },
      async setGoal(n) { people[0].monthly_goal = n; },
      async updateMember(id, patch) { Object.assign(people.find((p) => p.id === id), patch); },
    };
  }

  const api = DEMO ? demoApi() : realApi();

  // ---------- 状態 ----------
  const S = {
    me: null, levels: [], items: [], checks: new Map(), lessons: [],
    sport: store.get("triton-sport") || "wind",
    track: "basic", open: { basic: undefined, free: undefined },
    staff: { list: null, filter: "all", q: "" },
    detail: null, busy: false,
  };

  function trackView(track, checksMap, openLevel) {
    let certCount = 0, selfCount = 0, total = 0, current = null;
    const levels = S.levels.filter((l) => l.track === track).map((l) => {
      const items = S.items.filter((i) => i.track === track && i.level === l.level).map((i) => {
        const c = checksMap.get(i.id);
        const cert = !!(c && c.certified_at);
        const self = !cert && !!(c && c.self_checked_at);
        if (self) selfCount++;
        return { ...i, cert, self };
      });
      const n = items.filter((i) => i.cert).length;
      certCount += n; total += items.length;
      const cleared = items.length > 0 && n === items.length;
      if (!cleared && current === null) current = l.level;
      return { ...l, items, n, cleared };
    });
    levels.forEach((l) => { l.current = l.level === current; l.open = l.level === (openLevel === undefined ? current : openLevel); });
    return { levels, current, certCount, selfCount, total };
  }
  const mapChecks = (rows) => new Map(rows.map((r) => [r.item_id, r]));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0) + "%";

  // ---------- 画面の部品 ----------
  function nav(active) {
    const links = [
      ["#/", "ホーム", ICON.home, "home"],
      ["#/roadmap", "ロードマップ", ICON.flag, "roadmap"],
      ["#/history", "記録", ICON.list, "history"],
    ];
    if (isStaff(S.me)) links.push(["#/staff", "スタッフ", ICON.staff, "staff"]);
    return `<nav class="nav" aria-label="メニュー"><div class="nav-in">${links.map(([href, label, icon, key]) =>
      `<a href="${href}"${key === active ? ' aria-current="page"' : ""}>${icon}${label}</a>`).join("")}</div></nav>`;
  }

  function levelList(tv, mode) {
    // mode: "member"（自分でチェック） / "staff"（認定）
    return tv.levels.map((l) => `
      <div class="lv">
        <button type="button" class="lv-head" data-act="open" data-lv="${l.level}" aria-expanded="${l.open}">
          <span class="lv-num num" style="background:${esc(l.color)};color:${esc(l.fg)}">${l.level}</span>
          <span class="lv-txt"><b>${esc(l.theme)}</b><small>${esc(l.grade)}</small></span>
          ${l.current ? '<span class="pill now">挑戦中</span>' : ""}
          ${l.cleared ? `<span class="done-dot">${ICON.check}</span>` : ""}
          <span class="lv-count">${l.n}/${l.items.length}</span>
        </button>
        ${l.open ? `<div class="lv-body">${l.items.map((i) => itemRow(i, mode)).join("")}</div>` : ""}
      </div>`).join("");
  }

  function itemRow(i, mode) {
    const box = `<span class="box ${i.cert ? "cert" : i.self ? "self" : ""}">${i.cert || (i.self && mode === "member") ? ICON.check : ""}</span>`;
    const status = i.cert ? '<span class="certtxt">認定</span>'
      : i.self ? `<span class="pill wait">${mode === "staff" ? "本人チェック済み" : "認定待ち"}</span>` : "";
    if (mode === "member") {
      return `<button type="button" class="item" data-act="self" data-item="${esc(i.id)}" aria-pressed="${i.cert || i.self}"${i.cert ? " disabled" : ""}>${box}<span class="t">${esc(i.label)}</span>${status}</button>`;
    }
    return `<button type="button" class="item" data-act="cert" data-item="${esc(i.id)}" data-val="${!i.cert}" aria-pressed="${i.cert}">${box}<span class="t">${esc(i.label)}</span>${status}</button>`;
  }

  function trackTabs() {
    return `<div class="seg">${[["basic", "基礎・応用"], ["free", "フリースタイル"]].map(([id, label]) =>
      `<button type="button" data-act="track" data-track="${id}" aria-pressed="${S.track === id}">${label}</button>`).join("")}</div>`;
  }

  const legend = `<div class="legend"><span><span class="box self">${ICON.check}</span>自分でチェック</span><span><span class="box cert">${ICON.check}</span>インストラクター認定</span></div>`;

  // ---------- 各画面 ----------
  function viewHome() {
    const tv = trackView("basic", S.checks);
    const cur = tv.levels.find((l) => l.current);
    const month = todayJST().slice(0, 7);
    const monthCount = S.lessons.filter((l) => l.lesson_date.startsWith(month)).length;
    const lastComment = S.lessons.find((l) => l.comment);
    const wing = S.sport === "wing";
    const sportSeg = `<div class="seg">
      <button type="button" data-act="sport" data-sport="wind" aria-pressed="${!wing}">ウインドサーフィン</button>
      <button type="button" data-act="sport" data-sport="wing" aria-pressed="${wing}"><span>ウイングフォイル</span><span class="tag">製作中</span></button></div>`;
    let hero = "", body = "";
    if (!wing) {
      hero = cur ? `<div class="hero">
          <div class="hero-row"><div class="lvbig num" style="background:${esc(cur.color)};color:${esc(cur.fg)}">${cur.level}</div>
          <div><div class="sub">挑戦中 ・ ${esc(cur.grade)}</div><div class="theme">${esc(cur.theme)}</div></div></div>
          <div><div class="between"><span class="sub">レベル${cur.level} クリアまで</span><b>認定 ${cur.n} / ${cur.items.length}</b></div>
          <div class="bar" style="margin-top:6px"><i class="c" style="width:${pct(cur.n, cur.items.length)}"></i></div></div></div>`
        : `<div class="hero"><div class="theme">全レベル認定済み</div><div class="sub">おめでとうございます！</div></div>`;
      const next = cur ? cur.items.filter((i) => !i.cert) : [];
      body = `
        <div class="card"><div class="between"><h2>次の目標</h2><a href="#/roadmap" style="font-weight:700">ロードマップを見る</a></div>
          ${next.length ? next.map((i) => `<div class="goal"><span class="box ${i.self ? "self" : ""}" style="width:22px;height:22px">${i.self ? ICON.check : ""}</span><span class="t">${esc(i.label)}</span>${i.self ? '<span class="pill wait">認定待ち</span>' : ""}</div>`).join("") : '<p class="muted">すべての項目が認定されています。</p>'}
        </div>
        <div class="grid2">
          <div class="card"><div class="stat-label">海に出た回数（累計）</div><div class="stat"><span class="num">${S.lessons.length}</span><span>回</span></div></div>
          <div class="card"><div class="stat-label">${Number(month.slice(5))}月の目標</div>
            <div class="stat"><span class="num">${monthCount}</span><span>/ ${S.me.monthly_goal ? S.me.monthly_goal + " 回" : "—"}</span></div>
            <label class="small muted">目標回数 <select class="in" data-change="goal" aria-label="今月の目標回数" style="min-height:36px;padding:4px 8px;width:auto;display:inline-block">
              <option value="">未設定</option>${Array.from({ length: 12 }, (_, k) => k + 1).map((n) => `<option value="${n}"${S.me.monthly_goal === n ? " selected" : ""}>${n}回</option>`).join("")}</select></label>
          </div>
        </div>
        <div class="card"><div class="between"><h2>認定バッジ</h2><span class="small muted">${BADGES.filter((b) => b.lv < (tv.current ?? 11)).length} / ${BADGES.length} 獲得</span></div>
          <div class="badges">${BADGES.map((b) => { const on = b.lv < (tv.current ?? 11);
            return `<div class="badge"><div class="medal num ${on ? "on" : "off"}">${on ? b.lv : ICON.lock}</div><div${on ? ' style="font-weight:700"' : ' class="muted"'}>${b.name}</div></div>`; }).join("")}</div>
        </div>
        ${lastComment ? `<div class="card"><div class="between"><h2>インストラクターから</h2><span class="small muted">${fmtDate(lastComment.lesson_date)}</span></div>
          <p style="white-space:pre-wrap">${esc(lastComment.comment)}</p>${lastComment.instructor_name ? `<span class="small muted">${esc(lastComment.instructor_name)}</span>` : ""}</div>` : ""}`;
    } else {
      body = `<div class="card" style="align-items:center;text-align:center;padding:32px 20px;gap:12px">
        <div style="width:56px;height:56px;border-radius:50%;background:var(--wait-bg);color:var(--wait-fg);display:flex;align-items:center;justify-content:center">${ICON.tool}</div>
        <h2 style="font-size:18px">ウイングフォイルは製作中です</h2>
        <p class="muted">スキルロードマップを準備しています。<br>公開までしばらくお待ちください。</p>
        <button type="button" class="btn" data-act="sport" data-sport="wind">ウインドサーフィンに戻る</button></div>`;
    }
    return `<div class="shell"><header class="top"><div class="top-row"><div class="brand">Triton</div><div class="who">${esc(nameOf(S.me))} さん</div></div>${sportSeg}${hero}</header>
      <main class="main">${body}</main>${nav("home")}</div>`;
  }

  function viewRoadmap() {
    const tv = trackView(S.track, S.checks, S.open[S.track]);
    return `<div class="shell"><header class="top">
        <div><div class="sub">ウインドサーフィン ・ ${S.track === "basic" ? "基礎・応用編" : "フリースタイル編"}</div><h1>スキルロードマップ</h1></div>
        ${trackTabs()}
        <div><div class="between"><b>認定 ${tv.certCount} / ${tv.total}</b><span class="sub">認定待ち ${tv.selfCount}</span></div>
        <div class="bar" style="margin-top:6px"><i class="c" style="width:${pct(tv.certCount, tv.total)}"></i><i class="s" style="width:${pct(tv.selfCount, tv.total)}"></i></div></div>
      </header>
      <main class="main">${legend}<p class="small muted" style="margin:0 4px">できるようになった項目をタップすると「自分でチェック」が付きます。インストラクターが確認すると「認定」になります。</p>${levelList(tv, "member")}</main>${nav("roadmap")}</div>`;
  }

  function viewHistory() {
    return `<div class="shell"><header class="top"><div><div class="sub">これまでのレッスン</div><h1>記録</h1></div></header>
      <main class="main"><div class="card">${S.lessons.length ? S.lessons.map((l) => `<div class="lesson">
        <div class="between"><b>${fmtDate(l.lesson_date)}</b><span class="meta">${esc(l.instructor_name || "")}</span></div>
        ${l.comment ? `<p style="white-space:pre-wrap">${esc(l.comment)}</p>` : '<span class="meta">コメントなし</span>'}</div>`).join("")
        : '<div class="empty">まだ記録はありません。<br>レッスン後にインストラクターが記録します。</div>'}</div></main>${nav("history")}</div>`;
  }

  function viewStaffList() {
    const st = S.staff;
    if (!st.list) return `<div class="shell wide"><header class="top"><h1>会員一覧</h1></header><main class="main"><div class="empty">読み込み中…</div></main>${nav("staff")}</div>`;
    const follow = (m) => m.role === "member" && (m.last_lesson_date === null || daysSince(m.last_lesson_date) >= 30);
    const filters = [
      ["all", "すべて", () => true],
      ["wait", "認定待ちあり", (m) => m.waiting_count > 0],
      ["follow", "要フォロー", follow],
      ["staff", "スタッフ", (m) => m.role !== "member"],
    ];
    const q = st.q.trim().toLowerCase();
    const f = filters.find((x) => x[0] === st.filter)[2];
    const rows = st.list.filter((m) => f(m) && (!q || nameOf(m).toLowerCase().includes(q)))
      .sort((a, b) => (b.waiting_count - a.waiting_count) || String(b.last_lesson_date || "").localeCompare(String(a.last_lesson_date || "")));
    const lvChip = (m) => {
      if (m.sport === "wing") return `<span class="lvchip" style="background:#E4EAF0">製作中</span>`;
      const l = S.levels.find((x) => x.track === "basic" && x.level === m.current_level);
      return l ? `<span class="lvchip" style="background:${esc(l.color)};color:${esc(l.fg)}">Lv${l.level}</span>` : `<span class="lvchip pill ok">全認定</span>`;
    };
    return `<div class="shell wide"><header class="top"><div class="top-row"><h1>会員一覧</h1><span class="sub">${st.list.length}人</span></div>
        <input class="in" type="search" placeholder="名前でさがす" aria-label="名前でさがす" data-input="q" value="${esc(st.q)}" style="color:var(--ink)">
      </header>
      <main class="main">
        <div class="chips">${filters.map(([id, label, fn]) => `<button type="button" class="chip" data-act="filter" data-filter="${id}" aria-pressed="${st.filter === id}">${label} ${st.list.filter(fn).length}</button>`).join("")}</div>
        <div class="mlist">${rows.length ? rows.map((m) => {
          const days = daysSince(m.last_lesson_date);
          return `<a class="mrow" href="#/staff/${esc(m.id)}">
            ${m.line_picture_url ? `<img class="avatar" src="${esc(m.line_picture_url)}" alt="">` : '<span class="avatar"></span>'}
            <span class="nm"><b>${esc(nameOf(m))}</b><small>${m.role !== "member" ? roleLabel[m.role] + " ・ " : ""}${m.lesson_count}回 ・ 最終 ${fmtDate(m.last_lesson_date)}</small></span>
            ${m.waiting_count > 0 ? `<span class="pill wait">認定待ち ${m.waiting_count}</span>` : ""}
            ${follow(m) ? `<span class="pill warn">${days === null ? "来店記録なし" : days + "日"}</span>` : ""}
            ${lvChip(m)}</a>`; }).join("") : '<div class="empty">該当する会員はいません。</div>'}</div>
        <p class="small muted" style="margin:0">「要フォロー」は最終レッスンから30日以上あいた会員です。会員がLINEでアプリを開くと、ここに追加されます。</p>
      </main>${nav("staff")}</div>`;
  }

  function viewStaffDetail() {
    const d = S.detail;
    if (!d || !d.member) return `<div class="shell"><header class="top"><a class="back" href="#/staff">‹ 会員一覧</a></header><main class="main"><div class="empty">読み込み中…</div></main>${nav("staff")}</div>`;
    const m = d.member;
    const tv = trackView(S.track, d.checks, S.open[S.track]);
    const waiting = S.items.filter((i) => { const c = d.checks.get(i.id); return c && c.self_checked_at && !c.certified_at; })
      .map((i) => ({ ...i, cert: false, self: true }));
    const admin = S.me.role === "admin";
    return `<div class="shell"><header class="top">
        <a class="back" href="#/staff">‹ 会員一覧</a>
        <div class="top-row" style="justify-content:flex-start">
          ${m.line_picture_url ? `<img class="avatar" src="${esc(m.line_picture_url)}" alt="" style="width:48px;height:48px">` : ""}
          <div><h1>${esc(nameOf(m))}</h1><div class="sub">${roleLabel[m.role]} ・ ${m.sport === "wing" ? "ウイングフォイル" : "ウインドサーフィン"} ・ 累計${d.lessons.length}回 ・ 最終 ${fmtDate(d.lessons[0] && d.lessons[0].lesson_date)}</div></div>
        </div>
      </header>
      <main class="main">
        ${waiting.length ? `<div class="card" style="border-color:#E7C77A"><h2>本人チェック済み・認定待ち（${waiting.length}）</h2>
          <p class="small muted">確認できたらタップして認定します。</p>${waiting.map((i) => itemRow(i, "staff")).join("")}</div>` : ""}
        <div class="card"><h2>レッスンを記録</h2>
          <label class="f">日付<input class="in" type="date" id="lesson-date" value="${todayJST()}"></label>
          <label class="f">ひとことコメント（会員に表示）<textarea class="in" id="lesson-comment" rows="3" maxlength="1000" placeholder="今日よかった点と、次に挑戦すること"></textarea></label>
          <button type="button" class="btn" data-act="lesson"${S.busy ? " disabled" : ""}>記録を保存</button>
        </div>
        <div class="card" style="gap:12px"><h2>スキルの認定</h2>
          <div class="seg" style="background:#E4EAF0">${[["basic", "基礎・応用"], ["free", "フリースタイル"]].map(([id, label]) =>
            `<button type="button" data-act="track" data-track="${id}" aria-pressed="${S.track === id}" style="color:var(--ink)">${label}</button>`).join("")}</div>
          <div class="between"><b>認定 ${tv.certCount} / ${tv.total}</b><span class="small muted">タップで認定／もう一度タップで取り消し</span></div>
        </div>
        ${levelList(tv, "staff")}
        <div class="card"><h2>レッスン記録</h2>${d.lessons.length ? d.lessons.slice(0, 20).map((l) => `<div class="lesson">
          <div class="between"><b>${fmtDate(l.lesson_date)}</b><span class="meta">${esc(l.instructor_name || "")}</span></div>
          ${l.comment ? `<p style="white-space:pre-wrap">${esc(l.comment)}</p>` : '<span class="meta">コメントなし</span>'}</div>`).join("") : '<div class="empty">まだ記録はありません。</div>'}</div>
        ${admin ? `<div class="card"><h2>会員情報（管理者のみ）</h2>
          <label class="f">表示名（空欄ならLINEの名前：${esc(m.line_name || "")}）<input class="in" id="m-name" maxlength="50" value="${esc(m.display_name || "")}"></label>
          <label class="f">プラン<input class="in" id="m-plan" maxlength="30" value="${esc(m.plan || "")}" placeholder="例：月会員"></label>
          <label class="f">種目<select class="in" id="m-sport"><option value="wind"${m.sport === "wind" ? " selected" : ""}>ウインドサーフィン</option><option value="wing"${m.sport === "wing" ? " selected" : ""}>ウイングフォイル</option></select></label>
          <label class="f">役割<select class="in" id="m-role">${["member", "instructor", "admin"].map((r) => `<option value="${r}"${m.role === r ? " selected" : ""}>${roleLabel[r]}</option>`).join("")}</select></label>
          <button type="button" class="btn ghost" data-act="save-member"${S.busy ? " disabled" : ""}>会員情報を保存</button></div>` : ""}
      </main>${nav("staff")}</div>`;
  }

  // ---------- 画面の切り替え ----------
  function route() { return (location.hash || "#/").slice(1); }

  function render() {
    const r = route();
    let html;
    if (r.startsWith("/staff/") && isStaff(S.me)) html = viewStaffDetail();
    else if (r === "/staff" && isStaff(S.me)) html = viewStaffList();
    else if (r === "/roadmap") html = viewRoadmap();
    else if (r === "/history") html = viewHistory();
    else html = viewHome();
    const y = window.scrollY;
    $app.innerHTML = html;
    window.scrollTo(0, y);
  }

  async function loadMine() {
    const [checks, lessons] = await Promise.all([api.checks(S.me.id), api.lessons(S.me.id)]);
    S.checks = mapChecks(checks);
    S.lessons = lessons;
  }

  async function onRoute() {
    const r = route();
    window.scrollTo(0, 0);
    if (r === "/staff" && isStaff(S.me)) {
      render();
      S.staff.list = await api.overview();
    } else if (r.startsWith("/staff/") && isStaff(S.me)) {
      const id = r.slice(7);
      if (!S.detail || S.detail.id !== id) { S.detail = { id }; S.open = { basic: undefined, free: undefined }; }
      render();
      await loadDetail(id);
    } else if (["/", "/roadmap", "/history", ""].includes(r)) {
      await loadMine();
    }
    render();
  }

  async function loadDetail(id) {
    const [member, checks, lessons] = await Promise.all([api.member(id), api.checks(id), api.lessons(id)]);
    S.detail = { id, member, checks: mapChecks(checks), lessons };
  }

  // ---------- 操作 ----------
  async function act(el) {
    const a = el.dataset.act;
    if (a === "sport") { S.sport = el.dataset.sport; store.set("triton-sport", S.sport); return render(); }
    if (a === "track") { S.track = el.dataset.track; return render(); }
    if (a === "filter") { S.staff.filter = el.dataset.filter; return render(); }
    if (a === "open") {
      const lv = Number(el.dataset.lv);
      const inDetail = route().startsWith("/staff/");
      const tv = trackView(S.track, inDetail ? S.detail.checks : S.checks, S.open[S.track]);
      const isOpen = tv.levels.find((l) => l.level === lv).open;
      S.open[S.track] = isOpen ? null : lv;
      return render();
    }
    if (S.busy) return;
    S.busy = true;
    try {
      if (a === "self") {
        await api.toggleSelf(el.dataset.item);
        await loadMine();
      } else if (a === "cert") {
        const value = el.dataset.val === "true";
        if (!value && !confirm("この項目の認定を取り消しますか？")) return;
        await api.setCertified(S.detail.id, el.dataset.item, value);
        await loadDetail(S.detail.id);
        toast(value ? "認定しました" : "認定を取り消しました");
      } else if (a === "lesson") {
        const comment = document.getElementById("lesson-comment").value;
        const date = document.getElementById("lesson-date").value || null;
        await api.recordLesson(S.detail.id, comment, date);
        await loadDetail(S.detail.id);
        S.staff.list = null;
        toast("レッスンを記録しました");
      } else if (a === "save-member") {
        const patch = {
          display_name: document.getElementById("m-name").value.trim() || null,
          plan: document.getElementById("m-plan").value.trim() || null,
          sport: document.getElementById("m-sport").value,
          role: document.getElementById("m-role").value,
        };
        if (S.detail.id === S.me.id && patch.role !== "admin" && !confirm("自分の管理者権限を外すと、元に戻せなくなります。よろしいですか？")) return;
        await api.updateMember(S.detail.id, patch);
        await loadDetail(S.detail.id);
        if (S.detail.id === S.me.id) S.me = await api.me();
        S.staff.list = null;
        toast("会員情報を保存しました");
      }
    } catch (e) {
      console.error(e);
      toast("うまく保存できませんでした。通信状態を確認して、もう一度お試しください。");
    } finally {
      S.busy = false;
      render();
    }
  }

  $app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (el && !el.disabled) act(el);
  });
  $app.addEventListener("change", async (e) => {
    if (e.target.dataset.change === "goal") {
      const n = e.target.value ? Number(e.target.value) : null;
      try { await api.setGoal(n); S.me.monthly_goal = n; toast("目標を保存しました"); }
      catch (err) { console.error(err); toast("目標を保存できませんでした"); }
      render();
    }
  });
  $app.addEventListener("input", (e) => {
    if (e.target.dataset.input === "q") {
      S.staff.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const input = $app.querySelector('[data-input="q"]');
      if (input) { input.focus(); try { input.setSelectionRange(pos, pos); } catch { /* 無視 */ } }
    }
  });
  window.addEventListener("hashchange", () => { onRoute().catch(fatal); });

  function fatal(e) {
    console.error(e);
    $app.innerHTML = `<div class="fatal"><h1>うまく読み込めませんでした</h1><p>${esc(e && e.message ? e.message : "通信状態を確認してください。")}</p><button type="button" class="btn" onclick="location.reload()">もう一度読み込む</button></div>`;
  }

  // ---------- 起動 ----------
  (async () => {
    S.me = await api.boot();
    const cat = await api.catalog();
    S.levels = cat.levels;
    S.items = cat.items;
    if (DEMO) document.title = "Triton スキルアップ（お試し表示）";
    await onRoute();
  })().catch(fatal);
})();
