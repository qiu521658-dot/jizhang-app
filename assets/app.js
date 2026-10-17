(() => {
  "use strict";

  /*
   * 记账本主逻辑（原生 JavaScript，没有使用框架）
   * 阅读顺序：
   * 1. 分类、工具函数
   * 2. localStorage 读写
   * 3. 首页 / 明细 / 统计 / 我的 四个页面
   * 4. 记一笔弹层（金额键盘、分类、日期、备注）
   * 5. CSV / JSON 导入导出
   * 6. 按钮事件绑定
   */

  const STORAGE_KEY = "jizhang.v1";
  const VERSION = 1;

  // 分类配置：想新增分类时，在对应数组里加一项即可。
  // id 必须唯一，color 用于统计图，界面和统计会自动读取这里。
  const CATS = {
    expense: [
      { id: "food", name: "餐饮", emoji: "🍜", color: "#d9785a" },
      { id: "transport", name: "交通", emoji: "🚇", color: "#5b8fb9" },
      { id: "shopping", name: "购物", emoji: "🛍️", color: "#c07aa8" },
      { id: "study", name: "学习", emoji: "📚", color: "#c79a45" },
      { id: "fun", name: "娱乐", emoji: "🎬", color: "#7b78c4" },
      { id: "life", name: "生活", emoji: "🧺", color: "#a9845c" },
      { id: "health", name: "医疗", emoji: "💊", color: "#5fa98a" },
      { id: "other", name: "其他", emoji: "📦", color: "#8a968f" }
    ],
    income: [
      { id: "salary", name: "工资", emoji: "💼", color: "#3e8e6e" },
      { id: "bonus", name: "奖金", emoji: "🏆", color: "#c79a45" },
      { id: "invest", name: "理财", emoji: "📈", color: "#5b8fb9" },
      { id: "side", name: "兼职", emoji: "🧑‍💻", color: "#7b78c4" },
      { id: "gift", name: "红包", emoji: "🧧", color: "#d9785a" },
      { id: "other-in", name: "其他", emoji: "💰", color: "#8a968f" }
    ]
  };

  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const el = (id) => document.getElementById(id);

  const viewEl = el("view");
  const monthLabel = el("monthLabel");
  const backToday = el("backToday");
  const tabbar = document.querySelector(".tabbar");
  const fab = el("fab");
  const sheet = el("sheet");
  const sheetBackdrop = el("sheetBackdrop");
  const sheetClose = el("sheetClose");
  const catGrid = el("catGrid");
  const amountText = el("amountText");
  const dateInput = el("dateInput");
  const dateLabel = el("dateLabel");
  const noteInput = el("noteInput");
  const saveBtn = el("saveBtn");
  const deleteBtn = el("deleteBtn");
  const keypad = el("keypad");
  const toastEl = el("toast");
  const toastText = el("toastText");
  const toastUndo = el("toastUndo");
  const importFile = el("importFile");

  const now = new Date();
  const TODAY = ymd(now);
  let viewY = now.getFullYear();
  let viewM = now.getMonth();
  let tab = "home";

  let sheetType = "expense";
  let selectedCat = "food";
  let entry = "";
  let editingId = null;
  let sheetOpen = false;
  let sheetHideTimer = 0;

  let toastTimer = 0;
  let toastUndoHandler = null;
  let deferredPrompt = null;

  // 所有记录集中放在 state 里；金额统一用“分”保存，避免小数计算误差。
  let state = loadState();

  /* ---------------- utils ---------------- */

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function ymd(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function parseYmd(str) {
    const [y, m, d] = String(str).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function monthKey(y, m) {
    return `${y}-${pad2(m + 1)}`;
  }

  function uid() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function fmtMoney(cents) {
    return (cents / 100).toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function fmtMoneyShort(cents) {
    const yuan = cents / 100;
    if (Math.round(yuan * 100) % 100 === 0) {
      return Math.round(yuan).toLocaleString("zh-CN");
    }
    return yuan.toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function fmtBalance(cents) {
    return `${cents < 0 ? "−" : ""}¥${fmtMoney(Math.abs(cents))}`;
  }

  function fmtCompact(cents) {
    const yuan = cents / 100;
    if (yuan >= 10000) {
      return `${(yuan / 10000).toFixed(yuan >= 100000 ? 0 : 1).replace(/\.0$/, "")}万`;
    }
    return Math.round(yuan).toLocaleString("zh-CN");
  }

  function daysInMonth(y, m) {
    return new Date(y, m + 1, 0).getDate();
  }

  function isViewingCurrentMonth() {
    return viewY === now.getFullYear() && viewM === now.getMonth();
  }

  function catOf(tx) {
    const list = CATS[tx.type] || CATS.expense;
    return list.find((c) => c.id === tx.catId) || list[list.length - 1];
  }

  function dayName(dateStr) {
    const d = parseYmd(dateStr);
    if (dateStr === TODAY) return "今天";
    const y = parseYmd(TODAY);
    y.setDate(y.getDate() - 1);
    if (dateStr === ymd(y)) return "昨天";
    return "";
  }

  function shortDate(dateStr) {
    const d = parseYmd(dateStr);
    const label = dayName(dateStr);
    if (label) return label;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function longDate(dateStr) {
    const d = parseYmd(dateStr);
    const label = dayName(dateStr);
    const core = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
    return label ? `${label} · ${core}` : core;
  }

  /* ---------------- storage ---------------- */

  // 从 localStorage 读取数据；文件损坏或格式不对时回到空数据，保证页面能打开。
  function loadState() {
    const fallback = { version: VERSION, tx: [], budget: 0 };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const data = JSON.parse(raw);
      const tx = Array.isArray(data.tx) ? data.tx.map(normalizeTx).filter(Boolean) : [];
      const budget = Number.isFinite(Number(data.budget)) && Number(data.budget) > 0
        ? Math.round(Number(data.budget))
        : 0;
      return { version: VERSION, tx, budget };
    } catch (err) {
      return fallback;
    }
  }

  // 每次新增、修改、删除后调用，把最新数据写回浏览器。
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: VERSION,
        tx: state.tx,
        budget: state.budget
      }));
    } catch (err) {
      toast("保存失败，请检查浏览器存储空间");
    }
  }

  function normalizeTx(raw) {
    if (!raw || typeof raw !== "object") return null;
    const type = raw.type === "income" ? "income" : "expense";
    const amount = Math.round(Number(raw.amount));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const list = CATS[type];
    const fallbackCat = type === "income" ? "other-in" : "other";
    const catId = list.some((c) => c.id === raw.catId) ? raw.catId : fallbackCat;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || "")) ? String(raw.date) : TODAY;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
      type,
      amount,
      catId,
      date,
      note: typeof raw.note === "string" ? raw.note.slice(0, 30) : "",
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now()
    };
  }

  /* ---------------- rendering ---------------- */

  // 按当前顶部选中的月份筛选记录，并按日期、录入时间倒序排列。
  function monthTransactions() {
    const key = monthKey(viewY, viewM);
    return state.tx
      .filter((t) => t.date.startsWith(key))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  }

  function totals(list) {
    let expense = 0;
    let income = 0;
    for (const t of list) {
      if (t.type === "income") income += t.amount;
      else expense += t.amount;
    }
    return { expense, income, count: list.length, balance: income - expense };
  }

  // 只重绘当前标签页，页面切换时不会丢失数据。
  function render() {
    renderMonthBar();
    if (tab === "home") renderHome();
    else if (tab === "detail") renderDetail();
    else if (tab === "stats") renderStats();
    else renderMe();
  }

  function renderMonthBar() {
    monthLabel.textContent = `${viewY}年${viewM + 1}月`;
    backToday.hidden = isViewingCurrentMonth();
  }

  function txRow(tx, withDate) {
    const cat = catOf(tx);
    const sign = tx.type === "income" ? "+" : "−";
    const sub = withDate
      ? [tx.note, shortDate(tx.date)].filter(Boolean).join(" · ")
      : tx.note;
    return `
      <button class="tx" data-tx="${esc(tx.id)}" type="button">
        <span class="tx-ico" style="--soft:${cat.color}1c">${cat.emoji}</span>
        <span class="tx-main">
          <span class="tx-cat">${esc(cat.name)}</span>
          ${sub ? `<span class="tx-note">${esc(sub)}</span>` : ""}
        </span>
        <span class="tx-amt ${tx.type}">${sign}${fmtMoney(tx.amount)}</span>
      </button>`;
  }

  function renderHome() {
    const list = monthTransactions();
    const sum = totals(list);
    const budget = state.budget;
    let budgetHtml = "";
    if (budget > 0) {
      // 预算进度按“已花金额 ÷ 月预算”计算，超过 100% 时进度条封顶。
      const used = sum.expense / budget;
      const pct = Math.min(100, used * 100);
      const over = sum.expense > budget;
      budgetHtml = `
        <div class="budget ${over ? "over" : ""}">
          <div class="budget-row"><span>本月预算</span><strong>¥${fmtMoney(budget)}</strong></div>
          <div class="track"><div class="track-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="budget-hint">
            <span>已用 ${Math.round(used * 100)}%</span>
            <span class="${over ? "warn" : ""}">${over ? `超支 ¥${fmtMoney(sum.expense - budget)}` : `剩余 ¥${fmtMoney(budget - sum.expense)}`}</span>
          </div>
        </div>`;
    } else {
      budgetHtml = `
        <div class="budget budget-empty">
          <span>设置月度预算，花钱更有数</span>
          <button data-goto="me" type="button">去设置</button>
        </div>`;
    }

    const recent = list.slice(0, 8);
    const recentHtml = recent.length
      ? `<div class="list-card">${recent.map((t) => txRow(t, true)).join("")}</div>`
      : `<div class="empty">
          <div class="empty-ico">🧾</div>
          <h3>这个月还没有记录</h3>
          <p>点右下角「记一笔」<br>十秒钟记下今天的第一笔</p>
          <button class="ghost-btn" data-action="add" type="button">记第一笔</button>
        </div>`;

    viewEl.innerHTML = `
      <section class="hero">
        <div class="hero-top">
          <span>本月支出</span>
          <button class="hero-link" data-goto="stats" type="button">统计 ›</button>
        </div>
        <div class="hero-amount"><span class="cur">¥</span><span>${fmtMoney(sum.expense)}</span></div>
        <div class="hero-sub">
          <span>收入 ¥${fmtMoney(sum.income)}</span>
          <span class="sep"></span>
          <span>结余 ${fmtBalance(sum.balance)}</span>
        </div>
        ${budgetHtml}
      </section>

      <div class="section-head">
        <h2>最近记录</h2>
        <button class="link-btn" data-goto="detail" type="button">查看全部</button>
      </div>
      ${recentHtml}
      <p class="fineprint">数据只保存在当前浏览器 · 可在「我的」里导出备份</p>
    `;
  }

  function renderDetail() {
    const list = monthTransactions();
    const sum = totals(list);
    if (!list.length) {
      viewEl.innerHTML = `
        <div class="summary-strip"><span>${viewM + 1}月 · 暂无记录</span></div>
        <div class="empty" style="margin-top:10px">
          <div class="empty-ico">📒</div>
          <h3>明细会出现在这里</h3>
          <p>每一笔收支都可以点开修改或删除</p>
          <button class="ghost-btn" data-action="add" type="button">记一笔</button>
        </div>`;
      return;
    }

    const groups = new Map();
    for (const t of list) {
      if (!groups.has(t.date)) groups.set(t.date, []);
      groups.get(t.date).push(t);
    }

    const html = [...groups.entries()].map(([date, items]) => {
      const daySum = totals(items);
      const parts = [];
      if (daySum.expense) parts.push(`支出 ¥${fmtMoney(daySum.expense)}`);
      if (daySum.income) parts.push(`收入 ¥${fmtMoney(daySum.income)}`);
      return `
        <div class="day-group">
          <div class="day-head">
            <span>${longDate(date)}</span>
            <span class="day-sum">${parts.join(" · ")}</span>
          </div>
          <div class="list-card">${items.map((t) => txRow(t, false)).join("")}</div>
        </div>`;
    }).join("");

    viewEl.innerHTML = `
      <div class="summary-strip">
        <span>${viewM + 1}月 · 共 <strong>${sum.count}</strong> 笔</span>
        <span class="sep" style="width:3px;height:3px;border-radius:50%;background:#c3cabf"></span>
        <span>支出 <strong>¥${fmtMoney(sum.expense)}</strong></span>
        <span class="sep" style="width:3px;height:3px;border-radius:50%;background:#c3cabf"></span>
        <span>收入 <strong>¥${fmtMoney(sum.income)}</strong></span>
      </div>
      ${html}`;
  }

  function renderStats() {
    const list = monthTransactions();
    const sum = totals(list);
    const days = isViewingCurrentMonth() ? now.getDate() : daysInMonth(viewY, viewM);
    const avg = Math.round(sum.expense / Math.max(days, 1));

    const byCat = new Map();
    for (const t of list) {
      if (t.type !== "expense") continue;
      byCat.set(t.catId, (byCat.get(t.catId) || 0) + t.amount);
    }
    const cats = [...byCat.entries()]
      .map(([id, amount]) => {
        const cat = CATS.expense.find((c) => c.id === id) || CATS.expense[CATS.expense.length - 1];
        return { ...cat, amount };
      })
      .sort((a, b) => b.amount - a.amount);

    let donutStyle = "";
    let legend = "";
    if (cats.length && sum.expense > 0) {
      let acc = 0;
      donutStyle = `conic-gradient(${cats.map((c) => {
        const from = acc;
        acc += (c.amount / sum.expense) * 100;
        return `${c.color} ${from.toFixed(2)}% ${acc.toFixed(2)}%`;
      }).join(", ")})`;
      legend = `<div class="legend">${cats.map((c) => {
        const pct = (c.amount / sum.expense) * 100;
        return `
          <div class="legend-row">
            <span class="dot" style="--c:${c.color}"></span>
            <span class="legend-name">${c.emoji} ${esc(c.name)}</span>
            <span class="legend-amt">¥${fmtMoney(c.amount)}</span>
            <span class="legend-pct">${pct < 1 ? "<1" : Math.round(pct)}%</span>
          </div>`;
      }).join("")}</div>`;
    } else {
      legend = `<div style="padding:20px 0 16px;text-align:center;color:var(--muted);font-size:12px">这个月还没有支出记录</div>`;
    }

    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(viewY, viewM - i, 1);
      const key = monthKey(d.getFullYear(), d.getMonth());
      const exp = state.tx
        .filter((t) => t.type === "expense" && t.date.startsWith(key))
        .reduce((n, t) => n + t.amount, 0);
      months.push({ y: d.getFullYear(), m: d.getMonth(), exp });
    }
    const max = Math.max(...months.map((m) => m.exp), 1);
    const trend = months.map((m) => {
      const h = m.exp ? Math.max(4, Math.round((m.exp / max) * 86)) : 3;
      const current = m.y === viewY && m.m === viewM;
      return `
        <div class="trend-col ${current ? "current" : ""}">
          <span class="trend-val">${m.exp ? fmtCompact(m.exp) : ""}</span>
          <span class="trend-bar" style="height:${h}px"></span>
          <span class="trend-label">${m.m + 1}月</span>
        </div>`;
    }).join("");

    const maxSingle = list.reduce((n, t) => (t.type === "expense" ? Math.max(n, t.amount) : n), 0);

    viewEl.innerHTML = `
      <div class="stat-grid">
        <div class="stat-tile"><div class="label">日均支出</div><div class="value">¥${fmtMoneyShort(avg)}</div></div>
        <div class="stat-tile"><div class="label">记账笔数</div><div class="value">${sum.count}<small> 笔</small></div></div>
        <div class="stat-tile"><div class="label">单笔最高</div><div class="value">¥${fmtMoneyShort(maxSingle)}</div></div>
      </div>

      <div class="donut-card">
        <div class="donut-wrap">
          <div class="donut" style="${donutStyle ? `background:${donutStyle}` : ""}"></div>
          <div class="donut-center">
            <span class="cap">${viewM + 1}月支出</span>
            <span class="num">¥${fmtMoneyShort(sum.expense)}</span>
          </div>
        </div>
        ${legend}
      </div>

      <div class="section-head"><h2>近 6 个月支出</h2></div>
      <div class="trend-card"><div class="trend">${trend}</div></div>

      <p class="fineprint">收入 ¥${fmtMoney(sum.income)} · 结余 ${fmtBalance(sum.balance)}</p>
    `;
  }

  function renderMe() {
    const budgetValue = state.budget ? (state.budget / 100).toFixed(2).replace(/\.00$/, "") : "";
    viewEl.innerHTML = `
      <div class="stack">
        <section class="card">
          <div class="card-head">
            <h3>月度预算</h3>
            <span class="sub">每月自动套用</span>
          </div>
          <div class="budget-form">
            <label class="money-input">
              <span class="cur">¥</span>
              <input id="budgetInput" type="number" inputmode="decimal" min="0" step="0.01" placeholder="例如 3000" value="${budgetValue}" aria-label="月度预算">
            </label>
            <button class="solid-btn" data-action="save-budget" type="button">保存</button>
          </div>
          <p class="budget-note">设置后，首页会显示预算进度和剩余额度。留空保存即关闭预算提醒。</p>
        </section>

        <section class="card">
          <div class="card-head"><h3>数据与备份</h3><span class="sub">记录只存在本机</span></div>
          <button class="setting-row" data-action="export-csv" type="button">
            <span class="row-ico">📊</span>
            <span class="row-main"><span class="row-title">导出 CSV 表格</span><span class="row-desc">可用 Excel、WPS 打开查看</span></span>
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </button>
          <button class="setting-row" data-action="export" type="button">
            <span class="row-ico">📤</span>
            <span class="row-main"><span class="row-title">导出 JSON 备份</span><span class="row-desc">完整备份，换手机时用来恢复</span></span>
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </button>
          <button class="setting-row" data-action="import" type="button">
            <span class="row-ico">📥</span>
            <span class="row-main"><span class="row-title">导入备份</span><span class="row-desc">从备份文件恢复（会覆盖当前记录）</span></span>
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </button>
          <button class="setting-row danger" data-action="clear" type="button">
            <span class="row-ico">🗑️</span>
            <span class="row-main"><span class="row-title">清空所有记录</span><span class="row-desc">操作不可恢复，建议先导出备份</span></span>
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </button>
        </section>

        <section class="card">
          <div class="card-head"><h3>应用</h3><span class="sub">v1.0</span></div>
          <button class="setting-row" data-action="install" type="button">
            <span class="row-ico">📱</span>
            <span class="row-main"><span class="row-title">放到手机桌面</span><span class="row-desc">像 App 一样打开，支持离线使用</span></span>
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </button>
          <button class="setting-row" data-action="about" type="button">
            <span class="row-ico">🌿</span>
            <span class="row-main"><span class="row-title">关于记账本</span><span class="row-desc">简单、安静、不联网也能记</span></span>
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
          </button>
        </section>
      </div>

      <p class="fineprint">
        数据保存在当前浏览器中，不会上传到服务器。<br>
        更换手机、卸载浏览器或清理浏览数据前，请先导出备份。
      </p>
    `;
  }

  /* ---------------- sheet ---------------- */

  function renderCats() {
    const list = CATS[sheetType];
    catGrid.innerHTML = list.map((c) => `
      <button class="cat ${c.id === selectedCat ? "sel" : ""}" data-cat="${c.id}" type="button" style="--c:${c.color};--soft:${c.color}18;--soft-strong:${c.color}2b">
        <span class="ico">${c.emoji}</span>
        <span>${esc(c.name)}</span>
      </button>`).join("");
  }

  function entryToCents() {
    return Math.round((parseFloat(entry || "0") || 0) * 100);
  }

  function displayEntry() {
    if (!entry) return "0";
    const [intPart, decPart] = entry.split(".");
    const intNum = intPart.replace(/^0+(?=\d)/, "") || "0";
    const withComma = intNum.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return decPart === undefined ? withComma : `${withComma}.${decPart}`;
  }

  function renderAmount() {
    amountText.textContent = displayEntry();
    saveBtn.disabled = entryToCents() <= 0;
  }

  function setType(type) {
    sheetType = type;
    if (!CATS[type].some((c) => c.id === selectedCat)) {
      selectedCat = CATS[type][0].id;
    }
    sheet.dataset.type = type;
    document.querySelectorAll(".seg").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === type);
    });
    renderCats();
  }

  function updateDateLabel() {
    const value = dateInput.value || TODAY;
    const d = parseYmd(value);
    const label = dayName(value);
    dateLabel.textContent = label
      ? `${label} · ${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  }

  function openSheet(id = null) {
    window.clearTimeout(sheetHideTimer);
    editingId = id || null;
    let tx = null;
    if (id) tx = state.tx.find((t) => t.id === id);

    if (tx) {
      setType(tx.type);
      selectedCat = tx.catId;
      entry = (tx.amount / 100).toFixed(2).replace(/\.?0+$/, "");
      dateInput.value = tx.date;
      noteInput.value = tx.note || "";
      deleteBtn.hidden = false;
      saveBtn.textContent = "保存";
    } else {
      setType("expense");
      selectedCat = "food";
      entry = "";
      dateInput.value = TODAY;
      noteInput.value = "";
      deleteBtn.hidden = true;
      saveBtn.textContent = "保存";
    }

    renderCats();
    renderAmount();
    updateDateLabel();
    saveBtn.disabled = true;
    if (tx) saveBtn.disabled = false;

    sheet.hidden = false;
    sheetBackdrop.hidden = false;
    sheetBackdrop.classList.remove("open");
    sheet.classList.remove("open");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sheet.classList.add("open");
        sheetBackdrop.classList.add("open");
      });
    });
    sheetOpen = true;
  }

  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    sheet.classList.remove("open");
    sheetBackdrop.classList.remove("open");
    document.body.style.overflow = "";
    sheetHideTimer = window.setTimeout(() => {
      sheet.hidden = true;
      sheetBackdrop.hidden = true;
    }, 300);
  }

  // 新增或编辑后统一保存：先校验金额，再写入 state 和 localStorage。
  function saveTransaction() {
    const amount = entryToCents();
    if (amount <= 0) {
      toast("请先输入金额");
      return;
    }
    const snapshot = JSON.stringify(state.tx);
    const note = noteInput.value.trim();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateInput.value) ? dateInput.value : TODAY;

    if (editingId) {
      const tx = state.tx.find((t) => t.id === editingId);
      if (tx) {
        tx.type = sheetType;
        tx.amount = amount;
        tx.catId = selectedCat;
        tx.date = date;
        tx.note = note;
      }
    } else {
      state.tx.push({
        id: uid(),
        type: sheetType,
        amount,
        catId: selectedCat,
        date,
        note,
        createdAt: Date.now()
      });
      const d = parseYmd(date);
      viewY = d.getFullYear();
      viewM = d.getMonth();
    }

    persist();
    closeSheet();
    render();
    toast(editingId ? "已更新这笔记录" : "已记一笔", () => {
      state.tx = JSON.parse(snapshot);
      persist();
      render();
    });
    editingId = null;
  }

  function deleteTransaction() {
    if (!editingId) return;
    const tx = state.tx.find((t) => t.id === editingId);
    const cat = tx ? catOf(tx) : null;
    // 删除前二次确认，避免误触丢数据。
    const ok = confirm(
      `确定删除这笔记录吗？\n${cat ? `${cat.name} ¥${fmtMoney(tx.amount)}` : ""}\n删除后也可以点「撤销」短暂恢复。`
    );
    if (!ok) return;
    const snapshot = JSON.stringify(state.tx);
    state.tx = state.tx.filter((t) => t.id !== editingId);
    editingId = null;
    persist();
    closeSheet();
    render();
    toast("已删除这笔记录", () => {
      state.tx = JSON.parse(snapshot);
      persist();
      render();
    });
  }

  function pressKey(key) {
    if (key === "back") {
      entry = entry.slice(0, -1);
    } else if (key === ".") {
      if (!entry.includes(".")) entry = entry ? `${entry}.` : "0.";
    } else if (/^\d$/.test(key)) {
      const parts = entry.split(".");
      if (parts[1] !== undefined && parts[1].length >= 2) return;
      if (parts[1] === undefined && parts[0].replace(/^0+/, "").length >= 7) return;
      if (!entry || entry === "0") entry = key;
      else entry += key;
    }
    renderAmount();
  }

  /* ---------------- toast ---------------- */

  function hideToast() {
    window.clearTimeout(toastTimer);
    toastEl.classList.remove("show");
    window.setTimeout(() => {
      toastEl.hidden = true;
    }, 220);
  }

  function toast(message, undo) {
    window.clearTimeout(toastTimer);
    toastText.textContent = message;
    toastUndoHandler = undo || null;
    toastUndo.hidden = !undo;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add("show"));
    toastTimer = window.setTimeout(hideToast, undo ? 4800 : 2200);
  }

  /* ---------------- navigation ---------------- */

  function setTab(next) {
    if (!["home", "detail", "stats", "me"].includes(next)) return;
    tab = next;
    tabbar.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === next);
    });
    // 统计和设置页不需要记账按钮，避免遮住图表和说明文字。
    fab.hidden = next === "stats" || next === "me";
    render();
    window.scrollTo(0, 0);
  }

  function changeMonth(delta) {
    viewM += delta;
    if (viewM < 0) { viewM = 11; viewY -= 1; }
    if (viewM > 11) { viewM = 0; viewY += 1; }
    render();
  }

  /* ---------------- 导入 / 导出 ---------------- */

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function csvCell(value) {
    const text = String(value == null ? "" : value);
    // 逗号、换行、引号需要按 CSV 规则转义。
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportCsv() {
    const rows = [["日期", "类型", "分类", "金额（元）", "备注"]];
    const list = state.tx
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    for (const tx of list) {
      rows.push([
        tx.date,
        tx.type === "income" ? "收入" : "支出",
        catOf(tx).name,
        (tx.amount / 100).toFixed(2),
        tx.note
      ]);
    }
    const csv = "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadFile(`记账明细-${TODAY}.csv`, csv, "text/csv;charset=utf-8");
    toast("CSV 已导出，可用 Excel 打开");
  }

  function exportBackup() {
    const payload = {
      app: "jizhang",
      version: VERSION,
      exportedAt: new Date().toISOString(),
      monthlyBudget: state.budget,
      transactions: state.tx
    };
    downloadFile(`记账备份-${TODAY}.json`, JSON.stringify(payload, null, 2), "application/json");
    toast("备份文件已导出");
  }

  async function importBackup(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const rows = Array.isArray(data) ? data : data.transactions || data.records;
      if (!Array.isArray(rows)) throw new Error("bad format");
      const normalized = rows.map(normalizeTx).filter(Boolean);
      if (!normalized.length) throw new Error("empty");
      if (!confirm(`将导入 ${normalized.length} 条记录，并覆盖当前全部记录。确定继续吗？`)) return;
      state.tx = normalized;
      const b = Number(data.monthlyBudget);
      if (Number.isFinite(b) && b >= 0) state.budget = Math.round(b);
      persist();
      render();
      toast(`已恢复 ${normalized.length} 条记录`);
    } catch (err) {
      toast("文件无法识别，请选择本应用导出的备份");
    }
  }

  /* ---------------- install ---------------- */

  function installApp() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(() => {
        deferredPrompt = null;
      });
      return;
    }
    const ua = navigator.userAgent;
    if (/iphone|ipad|ipod/i.test(ua)) {
      alert("iPhone 添加到桌面：\n\n1. 用 Safari 打开这个网页\n2. 点底部中间的「分享」按钮\n3. 往下找到「添加到主屏幕」\n4. 点右上角「添加」");
    } else if (/android/i.test(ua)) {
      alert("安卓添加到桌面：\n\n用 Chrome 打开这个网页，点右上角「⋮」菜单，选择「添加到主屏幕」或「安装应用」。");
    } else {
      alert("请先用手机 Safari 或 Chrome 打开这个网页，再从浏览器菜单选择「添加到主屏幕」。");
    }
  }

  /* ---------------- events ---------------- */

  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => setTab(b.dataset.tab));
  });

  el("prevMonth").addEventListener("click", () => changeMonth(-1));
  el("nextMonth").addEventListener("click", () => changeMonth(1));
  backToday.addEventListener("click", () => {
    viewY = now.getFullYear();
    viewM = now.getMonth();
    render();
  });
  monthLabel.addEventListener("click", () => {
    viewY = now.getFullYear();
    viewM = now.getMonth();
    render();
  });

  fab.addEventListener("click", () => openSheet());

  viewEl.addEventListener("click", (e) => {
    const goto = e.target.closest("[data-goto]");
    if (goto) {
      setTab(goto.dataset.goto);
      return;
    }
    const txBtn = e.target.closest("[data-tx]");
    if (txBtn) {
      openSheet(txBtn.dataset.tx);
      return;
    }
    const actionBtn = e.target.closest("[data-action]");
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;
    if (action === "add") openSheet();
    else if (action === "save-budget") {
      const input = el("budgetInput");
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) {
        toast("请输入有效的预算金额");
        return;
      }
      state.budget = Math.round(value * 100);
      persist();
      render();
      toast(state.budget ? "预算已保存" : "已关闭预算提醒");
    } else if (action === "export-csv") {
      exportCsv();
    } else if (action === "export") {
      exportBackup();
    } else if (action === "import") {
      importFile.click();
    } else if (action === "clear") {
      if (!state.tx.length) {
        toast("目前没有记录");
        return;
      }
      if (confirm("确定清空全部记账记录吗？\n此操作不可恢复，建议先导出备份。")) {
        state.tx = [];
        persist();
        render();
        toast("已清空所有记录");
      }
    } else if (action === "install") {
      installApp();
    } else if (action === "about") {
      alert("记账本 v1.0\n\n一个安静的个人记账工具：\n· 收支记录与分类\n· 月度预算\n· 分类统计\n· 本地离线存储\n\n数据只保存在这台设备的浏览器里，不会上传。");
    }
  });

  sheetClose.addEventListener("click", closeSheet);
  sheetBackdrop.addEventListener("click", closeSheet);
  saveBtn.addEventListener("click", saveTransaction);
  deleteBtn.addEventListener("click", deleteTransaction);

  sheet.addEventListener("click", (e) => {
    const seg = e.target.closest(".seg");
    if (seg) setType(seg.dataset.type);
    const cat = e.target.closest("[data-cat]");
    if (cat) {
      selectedCat = cat.dataset.cat;
      renderCats();
    }
    const key = e.target.closest("[data-key]");
    if (key) pressKey(key.dataset.key);
  });

  dateInput.addEventListener("change", updateDateLabel);

  toastUndo.addEventListener("click", () => {
    const fn = toastUndoHandler;
    toastUndoHandler = null;
    hideToast();
    if (fn) fn();
  });

  importFile.addEventListener("change", () => {
    const file = importFile.files && importFile.files[0];
    if (file) importBackup(file);
    importFile.value = "";
  });

  document.addEventListener("keydown", (e) => {
    if (!sheetOpen) return;
    if (e.key === "Escape") {
      closeSheet();
      return;
    }
    const typing = e.target instanceof HTMLInputElement && e.target.type !== "date";
    if (e.key === "Enter") {
      e.preventDefault();
      saveTransaction();
      return;
    }
    if (typing) return;
    if (/^\d$/.test(e.key) || e.key === ".") {
      e.preventDefault();
      pressKey(e.key);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      pressKey("back");
    }
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  /* ---------------- boot ---------------- */

  keypad.innerHTML = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"].map((k) => (
    `<button class="key" data-key="${k}" type="button">${k}</button>`
  )).join("") + `
    <button class="key" data-key="back" type="button" aria-label="退格">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9L3.5 12z"/><path d="m11 9 5 6M16 9l-5 6"/></svg>
    </button>`;

  sheet.dataset.type = "expense";
  renderCats();
  render();
})();
