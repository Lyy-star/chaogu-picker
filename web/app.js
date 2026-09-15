/* lyy创意选股 前端主逻辑（无框架，纯 DOM） */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  };

  const state = {
    picks: null,
    overview: null,
    events: null,
    portfolio: null,
    tab: 'top',
    detailCode: null,
    detailCache: new Map(),
    watch: loadWatch(),
    holdings: loadHoldings(),
    holdCash: loadHoldCash(),
    holdingAdvice: null,
    adviceKeys: {},
    adviceReady: false,
    search: null,
    searchQ: '',
    loadingPicks: false,
    loadingPortfolio: false,
  };

  /* ---------------------- 工具 ---------------------- */

  async function api(path, options) {
    const res = await fetch(path, options);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || '请求失败');
    return json.data;
  }

  function num(v, digits = 2) {
    if (!Number.isFinite(v)) return '-';
    return v.toFixed(digits);
  }

  function yi(v) {
    if (!Number.isFinite(v)) return '-';
    const abs = Math.abs(v);
    if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
    if (abs >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
    return v.toFixed(0);
  }

  function pctClass(v) {
    if (!Number.isFinite(v)) return 'flat';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return 'flat';
  }

  function pctText(v, digits = 2) {
    if (!Number.isFinite(v)) return '-';
    return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
  }

  function money(v, digits = 2) {
    if (!Number.isFinite(v)) return '-';
    return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function signedMoney(v, digits = 2) {
    if (!Number.isFinite(v)) return '-';
    return `${v > 0 ? '+' : v < 0 ? '-' : ''}${money(Math.abs(v), digits)}`;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(msg, ms = 2600) {
    const node = $('#toast');
    node.textContent = msg;
    node.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { node.hidden = true; }, ms);
  }

  function setStatus(text) {
    $('#statusText').textContent = text;
  }

  /* ---------------------- 自选 ---------------------- */

  function loadWatch() {
    try {
      return JSON.parse(localStorage.getItem('chaogu.watch') || '[]');
    } catch (_) {
      return [];
    }
  }

  function saveWatch() {
    localStorage.setItem('chaogu.watch', JSON.stringify(state.watch));
  }

  function isWatched(code) {
    return state.watch.some((w) => w.code === code);
  }

  function toggleWatch(code, name, cost) {
    if (isWatched(code)) {
      state.watch = state.watch.filter((w) => w.code !== code);
      toast(`已移出自选：${name}`);
    } else {
      state.watch = [...state.watch, { code, name, cost: cost || null, addedAt: Date.now() }];
      toast(`已加入自选：${name}`);
    }
    saveWatch();
    if (state.tab === 'watch') render();
    else refreshStars();
  }

  /* ---------------------- 我的持仓（真实持仓，存本机） ---------------------- */

  function loadHoldings() {
    try {
      const list = JSON.parse(localStorage.getItem('chaogu.holdings') || '[]');
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  function saveHoldings() {
    localStorage.setItem('chaogu.holdings', JSON.stringify(state.holdings));
  }

  function loadHoldCash() {
    const v = Number(localStorage.getItem('chaogu.holdCash'));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function saveHoldCash() {
    localStorage.setItem('chaogu.holdCash', String(state.holdCash || 0));
  }

  function isHeld(code) {
    return state.holdings.some((h) => h.code === code);
  }

  function addHolding(code, name) {
    if (isHeld(code)) return false;
    state.holdings = [
      ...state.holdings,
      { code, name, shares: 0, cost: null, addedAt: Date.now() },
    ];
    saveHoldings();
    return true;
  }

  function removeHolding(code, name) {
    state.holdings = state.holdings.filter((h) => h.code !== code);
    delete state.adviceKeys[code];
    saveHoldings();
    toast(`已移出持仓：${name || code}`);
  }

  function refreshStars() {
    document.querySelectorAll('.star').forEach((node) => {
      node.classList.toggle('on', isWatched(node.dataset.code));
      node.textContent = isWatched(node.dataset.code) ? '★' : '☆';
    });
  }

  /* ---------------------- 顶部行情 ---------------------- */

  function renderMarketStrip() {
    const box = $('#marketStrip');
    const o = state.overview;
    if (!o) return;
    box.innerHTML = '';

    (o.indexes || []).forEach((idx) => {
      const node = el('div', 'idx');
      node.innerHTML =
        `<span class="idx-name">${idx.name}</span>` +
        `<span class="idx-val">${num(idx.price)}</span>` +
        `<span class="idx-pct ${pctClass(idx.changePct)}">${pctText(idx.changePct)}</span>`;
      box.appendChild(node);
    });

    if (o.breadth) {
      const node = el('div', 'idx');
      node.innerHTML =
        `<span class="idx-name">主板涨跌</span>` +
        `<span class="idx-pct up">${o.breadth.up}涨</span>` +
        `<span class="idx-pct down">${o.breadth.down}跌</span>`;
      box.appendChild(node);
    }

    if (o.sentiment) {
      const s = o.sentiment;
      const cls = s.score >= 70 ? 'hot' : s.score <= 40 ? 'cold' : '';
      const node = el('div', 'idx');
      node.innerHTML =
        `<span class="idx-name">情绪</span>` +
        `<span class="badge ${cls}">${s.level}</span>` +
        `<span class="idx-name">涨停 ${s.limitUp} / 最高 ${s.maxStreak} 板</span>`;
      box.appendChild(node);
    }

    const stamp = el('div', 'idx');
    stamp.innerHTML = `<span class="idx-name">更新 ${new Date(
      o.at || Date.now(),
    ).toLocaleTimeString('zh-CN', { hour12: false })}</span>`;
    box.appendChild(stamp);
  }

  /* ---------------------- 列表 ---------------------- */

  const HEAD = ['排名', '股票', '现价', '涨跌幅', '评分', '买入区间', '止损 / 目标', '仓位', '入选理由'];

  function renderListHead() {
    const head = $('#listHead');
    head.innerHTML = '';
    HEAD.forEach((h) => head.appendChild(el('div', '', h)));
  }

  function currentItems() {
    const p = state.picks;
    if (!p) return [];
    if (state.tab === 'top') return p.top || [];
    if (state.tab === 'sentiment') return (p.sentiment && p.sentiment.items) || [];
    if (state.tab === 'news') return (p.news && p.news.items) || [];
    if (state.tab === 'event') return (p.event && p.event.items) || [];
    if (state.tab === 'fundamental') return (p.fundamental && p.fundamental.items) || [];
    return [];
  }

  function renderRow(item, index) {
    const row = el('div', 'row');
    row.dataset.code = item.code;
    if (state.detailCode === item.code) row.classList.add('active');

    const score = item.score || 0;
    const plan = item.plan || {};
    const zone = plan.buyZone ? `${num(plan.buyZone.low)}-${num(plan.buyZone.high)}` : '-';
    const t1 = plan.targets && plan.targets[0] ? num(plan.targets[0].price) : '-';
    const reason = (item.reasons && item.reasons[0]) || '';

    const tags = [];
    if (state.tab === 'top') tags.push(item.categoryName);
    const tagSource = item.badges && item.badges.length ? item.badges : item.boardNames || [];
    tagSource.slice(0, 3).forEach((b) => tags.push(b));
    if (item.events && item.events.length) tags.push(item.events[0]);

    row.innerHTML =
      `<div class="rank ${index < 3 ? 'top' : ''}">${index + 1}</div>` +
      `<div class="name-cell">
         <div class="name-line">
           <span class="stock-name">${item.name || item.code}</span>
           <span class="stock-code">${item.code}</span>
         </div>
         <div class="tags">${tags.slice(0, 3).map((t) => `<span class="tag">${t}</span>`).join('')}</div>
       </div>` +
      `<div class="num">${num(item.price)}</div>` +
      `<div class="num ${pctClass(item.changePct)}">${pctText(item.changePct)}</div>` +
      `<div class="score-cell">
         <div class="score-ring" style="--p:${Math.round(score)}"><span>${Math.round(score)}</span></div>
       </div>` +
      `<div class="zone">${zone}<div class="sub">估算胜率 ${num(item.winRate, 1)}%</div></div>` +
      `<div class="zone down">${num(plan.stopLoss)}<div class="sub up">目标 ${t1}</div></div>` +
      `<div class="zone">${plan.positionPct || '-'}%<div class="sub">盈亏比 ${num(plan.riskReward, 2)}</div></div>` +
      `<div class="reason-cell" title="${escapeAttr(reason)}">${reason}</div>`;

    row.addEventListener('click', (e) => {
      if (e.target.closest('.star')) return;
      openDetail(item.code, item);
    });
    return row;
  }

  function escapeAttr(s) {
    return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function render() {
    const withSearch = state.tab === 'watch' || state.tab === 'holding';
    $('#searchBar').hidden = !withSearch;
    $('#searchBar').querySelector('input').placeholder = state.tab === 'holding'
      ? '查股票：代码 / 名称 / 拼音首字母，加到持仓里我帮你盯着'
      : '查股票：代码 / 名称 / 拼音首字母，例如 600519、贵州茅台、gzmt';
    if (!withSearch) $('#searchResults').hidden = true;
    $('#listHead').hidden = state.tab === 'holding';
    if (state.tab === 'portfolio') return renderPortfolio();
    renderListHead();
    const head = $('#catHead');
    const list = $('#list');

    if (state.tab === 'calendar') return renderCalendar();
    if (state.tab === 'watch') return renderWatch();
    if (state.tab === 'holding') return renderHoldings();

    head.hidden = false;
    const cat = state.tab === 'top' ? null : state.picks && state.picks[state.tab];

    if (state.tab === 'top') {
      $('#catTitle').textContent = '今日推荐（四类合并排序）';
      $('#catHeadline').textContent = state.picks
        ? `按"评分 + 期望收益"排序，全市场主板选股，最近更新 ${new Date(state.picks.at).toLocaleTimeString('zh-CN', { hour12: false })}`
        : '正在计算…';
      $('#catMethod').innerHTML =
        '把基本面类、情绪类、消息类、大事件类四份结果放在一起排序。排序分 = 0.65 × 综合评分 + 0.35 × 期望收益（胜率 × 赔率估算）。' +
        '<br><br><b>免责声明：</b>所有评分、胜率、买卖价位都是基于公开行情与公开信息的规则化推算，' +
        '是"相对排序"而不是对未来收益的保证。股市有风险，请自行判断并按纪律执行。';
    } else if (cat) {
      $('#catTitle').textContent = cat.categoryName || '';
      $('#catHeadline').textContent = cat.headline || '';
      $('#catMethod').innerHTML = `${cat.methodology || ''}<br><br><b>免责声明：</b>评分与价位由规则模型动态计算，非投资建议，风险自担。`;
    } else {
      $('#catTitle').textContent = '';
      $('#catHeadline').textContent = '正在计算…';
      $('#catMethod').innerHTML = '';
    }

    const items = currentItems();
    list.innerHTML = '';

    if (state.loadingPicks && !items.length) {
      list.appendChild(loadingNode('正在抓取全市场行情并计算（首次约 15 秒）…'));
      return;
    }
    if (!items.length) {
      const catData = state.tab === 'top' ? null : state.picks && state.picks[state.tab];
      const err = catData && catData.error;
      list.appendChild(emptyNode(err ? `这一类暂时没算出来：${err}` : '暂无符合条件的股票（可能被过滤条件全部排除）'));
      return;
    }
    items.forEach((item, i) => list.appendChild(renderRow(item, i)));
    refreshStars();
  }

  function loadingNode(text) {
    const node = el('div', 'loading');
    node.appendChild(el('div', 'spinner'));
    node.appendChild(el('div', '', text));
    return node;
  }

  function emptyNode(text) {
    return el('div', 'empty', text);
  }

  /* ---------------------- 事件日历 ---------------------- */

  function renderCalendar() {
    $('#catHead').hidden = false;
    $('#catTitle').textContent = '事件日历';
    $('#catHeadline').textContent = '按"影响力 × 时间临近度"排序，未来 60 天内的事件';
    $('#catMethod').innerHTML =
      '事件来源：内置周期规律库 + 7×24 快讯实时抽取。<b>标注"待核实"的事件，日期是按往年规律推算的，' +
      '请以官方公告为准</b>。事件对股价的影响是"预期博弈"，通常买在事前、卖在事中，务必按卖出纪律执行。';

    renderListHead();
    const list = $('#list');
    list.innerHTML = '';
    if (!state.events) {
      list.appendChild(loadingNode('正在整理事件日历…'));
      return;
    }
    const events = state.events.events || [];
    if (!events.length) {
      list.appendChild(emptyNode('未来 60 天内暂无事件'));
      return;
    }
    events.forEach((ev) => list.appendChild(renderEventCard(ev)));
  }

  function renderEventCard(ev) {
    const card = el('div', `ev-card${ev.verify ? ' pending' : ''}`);
    const when = ev.daysUntil < 0
      ? `进行中（至 ${ev.endDate}）`
      : ev.daysUntil === 0
        ? '今天'
        : `${ev.daysUntil} 天后`;
    const boards = (ev.matchedBoards || []).map((b) => `<span class="tag">${b.name}</span>`).join('');
    card.innerHTML =
      `<div class="ev-top">
         <span class="ev-name">${ev.name}</span>
         <span class="ev-date">${ev.date}${ev.endDate && ev.endDate !== ev.date ? ` ~ ${ev.endDate}` : ''} · ${when}</span>
       </div>
       <div class="ev-impact">${ev.impact || ''}</div>
       <div class="ev-meta">
         <span class="badge">${ev.category || '事件'}</span>
         <span class="badge ${ev.level >= 4 ? 'hot' : ''}">影响力 ${ev.level || 3}/5</span>
         ${ev.verify ? '<span class="badge cold">日期待核实</span>' : ''}
         <span class="badge">${ev.source || ''}</span>
         ${boards}
       </div>`;
    return card;
  }

  /* ---------------------- 自选 ---------------------- */

  const WATCH_ANALYZE_LIMIT = 12;

  async function renderWatch() {
    $('#catHead').hidden = false;
    $('#catTitle').textContent = '自选股';
    $('#catHeadline').textContent = state.watch.length
      ? `共 ${state.watch.length} 只，每只都用和推荐列表同一套规则算技术面与资金面`
      : '用上面的搜索框查股票，搜到了直接加进来';
    $('#catMethod').innerHTML =
      '自选保存在本机。每只票都会算技术面 / 资金面评分（口径与「今日推荐」一致：技术面 60% + 资金面 40%），' +
      '并给出买入区间、止损、目标价、建议仓位和卖出条件；填上成本价还能看浮动盈亏。';

    renderListHead();
    const list = $('#list');
    list.innerHTML = '';
    renderSearchResults(state.search);

    if (!state.watch.length) {
      list.appendChild(emptyNode('还没有自选股，上面搜一只加进来试试'));
      return;
    }
    list.appendChild(loadingNode('正在拉取自选股行情并计算…'));

    const results = await Promise.all(
      state.watch.slice(0, WATCH_ANALYZE_LIMIT).map((w) =>
        api(`/api/stock/${w.code}`)
          .then((data) => ({ w, data }))
          .catch(() => ({ w, data: null })),
      ),
    );
    list.innerHTML = '';
    results.forEach(({ w, data }) => list.appendChild(renderWatchCard(w, data)));

    if (state.watch.length > WATCH_ANALYZE_LIMIT) {
      list.appendChild(
        emptyNode(
          `先分析前 ${WATCH_ANALYZE_LIMIT} 只，还有 ${state.watch.length - WATCH_ANALYZE_LIMIT} 只没展开（一次抓太多会明显变慢）`,
        ),
      );
    }
  }

  function renderWatchCard(w, data) {
    const row = el('div', 'ev-card');
    const code = esc(w.code);
    const nameAttr = escapeAttr(w.name || '');

    if (!data) {
      row.innerHTML =
        `<div class="ev-top">
           <span class="ev-name">${esc(w.name || w.code)} <span class="stock-code">${code}</span></span>
           <button class="btn ghost watch-del" data-code="${code}" data-name="${nameAttr}">移出</button>
         </div>
         <div class="ev-impact">这只票暂时拉不到行情，稍后再刷新看看。</div>`;
      row.querySelector('.watch-del').addEventListener('click', () => toggleWatch(w.code, w.name || ''));
      return row;
    }

    const q = data.quote || {};
    const plan = data.plan || {};
    const v = data.verdict || {};
    const cost = Number(w.cost);
    const profit = Number.isFinite(cost) && cost > 0 && Number.isFinite(q.price)
      ? ((q.price - cost) / cost) * 100
      : null;

    const zone = plan.buyZone ? `${num(plan.buyZone.low)} - ${num(plan.buyZone.high)}` : '-';
    const t1 = plan.targets && plan.targets[0] ? num(plan.targets[0].price) : '-';
    const sellHint = (plan.sellRules && plan.sellRules[0]) || '暂无卖出信号';
    const verdictCls = Number.isFinite(v.total) ? (v.total >= 60 ? 'hot' : v.total < 45 ? 'cold' : '') : '';
    const reasons = (v.reasons || []).slice(0, 3);

    row.innerHTML =
      `<div class="ev-top">
         <span class="ev-name clickable" title="点名称看完整分析">${esc(w.name || q.name || w.code)}
           <span class="stock-code">${code}</span></span>
         <span class="ev-date ${pctClass(q.changePct)}">${num(q.price)} ${pctText(q.changePct)}</span>
       </div>
       <div class="ev-meta">
         ${Number.isFinite(v.total) ? `<span class="badge ${verdictCls}">评分 ${num(v.total, 1)} · ${esc(v.stance)}</span>` : ''}
         ${Number.isFinite(v.tech) ? `<span class="badge">技术面 ${Math.round(v.tech)}</span>` : ''}
         ${Number.isFinite(v.fund) ? `<span class="badge">资金面 ${Math.round(v.fund)}</span>` : ''}
         <span class="badge">成本
           <input class="cost-input" data-code="${code}" value="${Number.isFinite(cost) ? cost : ''}"
                  placeholder="填成本价" style="width:64px;background:#232a36;border:1px solid #2b3341;color:#e6e9ef;border-radius:4px;padding:1px 5px;font-size:11px" />
         </span>
         ${profit === null ? '' : `<span class="badge ${profit >= 0 ? 'hot' : 'cold'}">浮动盈亏 ${pctText(profit)}</span>`}
         <button class="btn ghost watch-open" data-code="${code}">看图</button>
         <button class="btn ghost watch-del" data-code="${code}" data-name="${nameAttr}">移出</button>
       </div>
       <div class="ev-impact">
         买入区间 ${zone} ｜ 止损 ${num(plan.stopLoss)} ｜ 目标 ${t1} ｜ 建议仓位 ${plan.positionPct || '-'}%<br />
         卖出提示：${esc(sellHint)}
       </div>
       ${reasons.length
         ? `<div class="analysis-line"><b>${esc(v.stanceText || '')}</b><br />${reasons
             .map((r) => '· ' + esc(r))
             .join('<br />')}</div>`
         : ''}`;

    row.querySelector('.watch-del').addEventListener('click', () => toggleWatch(w.code, w.name || ''));
    row.querySelector('.watch-open').addEventListener('click', () => openDetail(w.code, null));
    row.querySelector('.ev-name').addEventListener('click', () => openDetail(w.code, null));
    const input = row.querySelector('.cost-input');
    input.addEventListener('change', () => {
      const item = state.watch.find((x) => x.code === w.code);
      if (item) {
        item.cost = Number(input.value) || null;
        saveWatch();
        toast('成本价已保存');
        renderWatch();
      }
    });
    return row;
  }

  /* ---------------------- 我的持仓：页面 ---------------------- */

  const HOLDING_POLL_MS = 60 * 1000;

  function holdingCard(holding, item) {
    const card = el('div', 'ev-card hold-card');
    const code = esc(holding.code);
    const quote = (item && item.quote) || {};
    const plan = (item && item.plan) || {};
    const adv = (item && item.advice) || {};
    const shares = Number(holding.shares) || 0;
    const cost = Number(holding.cost) || 0;
    const price = Number(quote.price);
    const profitPct = cost > 0 && Number.isFinite(price) ? ((price - cost) / cost) * 100 : null;
    const marketValue = Number.isFinite(price) ? price * shares : 0;
    const actionCls = adv.action === 'add' ? 'hot' : adv.action === 'trim' || adv.action === 'exit' ? 'cold' : '';
    const zone = plan.buyZone ? `${num(plan.buyZone.low)} - ${num(plan.buyZone.high)}` : '-';
    const moveWord = adv.action === 'add' ? '加仓' : '卖出';

    card.innerHTML =
      `<div class="ev-top">
         <span class="ev-name clickable" title="点名称看完整分析">${esc(holding.name || quote.name || holding.code)}
           <span class="stock-code">${code}</span></span>
         <span class="ev-date ${pctClass(quote.changePct)}">${num(quote.price)} ${pctText(quote.changePct)}</span>
       </div>
       <div class="ev-meta">
         ${adv.actionText ? `<span class="badge ${actionCls}">${esc(adv.actionText)}</span>` : ''}
         ${adv.lot > 0 ? `<span class="badge ${actionCls}">${moveWord} ${adv.lot} 股 · 约 ${money(adv.amount)} 元</span>` : ''}
         ${profitPct === null ? '' : `<span class="badge ${profitPct >= 0 ? 'hot' : 'cold'}">浮动盈亏 ${pctText(profitPct)}</span>`}
         <span class="badge">市值 ${money(marketValue)}</span>
       </div>
       <div class="ev-meta hold-inputs">
         <span class="badge">持股 <input class="hold-input hold-shares" type="number" min="0" step="100"
                value="${shares || ''}" placeholder="0" /> 股</span>
         <span class="badge">成本 <input class="hold-input hold-cost" type="number" min="0" step="0.01"
                value="${cost || ''}" placeholder="买入均价" /> 元</span>
         <button class="btn ghost hold-open">看图</button>
         <button class="btn ghost hold-del">移出持仓</button>
       </div>
       <div class="ev-impact">
         买入区间 ${zone} ｜ 止损 ${num(plan.stopLoss)} ｜
         目标 ${plan.targets && plan.targets[0] ? num(plan.targets[0].price) : '-'} ｜ 建议仓位上限 ${plan.positionPct || '-'}%
       </div>
       ${(adv.reasons || []).length
         ? `<div class="analysis-line">${(adv.reasons || []).slice(0, 3).map((r) => '· ' + esc(r)).join('<br />')}</div>`
         : ''}`;

    card.querySelector('.ev-name').addEventListener('click', () => openDetail(holding.code, null));
    card.querySelector('.hold-open').addEventListener('click', () => openDetail(holding.code, null));
    card.querySelector('.hold-del').addEventListener('click', () => {
      removeHolding(holding.code, holding.name);
      render();
    });

    const sharesInput = card.querySelector('.hold-shares');
    const costInput = card.querySelector('.hold-cost');
    const saveField = () => {
      const target = state.holdings.find((h) => h.code === holding.code);
      if (!target) return;
      target.shares = Math.max(0, Math.round(Number(sharesInput.value) || 0));
      target.cost = Number(costInput.value) > 0 ? Number(costInput.value) : null;
      saveHoldings();
      toast(`${holding.name || holding.code} 持仓已保存`);
      refreshHoldingAdvice({ notify: false }).then(() => {
        if (state.tab === 'holding') render();
      });
    };
    sharesInput.addEventListener('change', saveField);
    costInput.addEventListener('change', saveField);
    return card;
  }

  async function renderHoldings() {
    $('#catHead').hidden = false;
    $('#catTitle').textContent = '我的持仓';
    $('#catHeadline').textContent = state.holdings.length
      ? `共 ${state.holdings.length} 只，盘中每分钟按分时价和交易计划帮你盯着加仓 / 卖出点`
      : '用上面的搜索框查股票，加到持仓里，我来帮你盯买卖点';
    $('#catMethod').innerHTML =
      '持仓记在本机。填上<b>持股数和成本</b>，再填一下<b>可用资金</b>，' +
      '我会用实时价 + 分时均价 + 交易计划（买入区间 / 止损 / 目标位）判断现在该加仓、减仓还是止损，' +
      '并算出具体多少股、大概多少钱。触发条件时会弹窗 + 响一下提醒你。' +
      '<br><br><b>免责声明：</b>所有判断都是规则化推算，不是投资建议，买卖自己负责。';

    const list = $('#list');
    list.innerHTML = '';
    renderSearchResults(state.search);

    const head = el('div', 'hold-head');
    head.innerHTML =
      `<span class="badge">可用资金 <input id="holdCashInput" type="number" min="0" step="1000"
          value="${state.holdCash || ''}" placeholder="例如 50000" /> 元</span>
       <button class="btn" id="holdCheckBtn">立即检查一次</button>
       <button class="btn ghost" id="holdRefreshBtn">刷新行情</button>
       <span class="stock-code" id="holdCheckedAt">${state.holdingAdvice ? `上次检查 ${new Date(state.holdingAdvice.at).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</span>`;
    list.appendChild(head);

    const cashInput = head.querySelector('#holdCashInput');
    cashInput.addEventListener('change', () => {
      state.holdCash = Math.max(0, Number(cashInput.value) || 0);
      saveHoldCash();
      toast('可用资金已保存');
      refreshHoldingAdvice({ notify: false }).then(() => {
        if (state.tab === 'holding') render();
      });
    });

    head.querySelector('#holdRefreshBtn').addEventListener('click', async () => {
      await refreshHoldingAdvice({ notify: false, force: true });
      if (state.tab === 'holding') render();
    });
    head.querySelector('#holdCheckBtn').addEventListener('click', async () => {
      head.querySelector('#holdCheckBtn').disabled = true;
      const data = await refreshHoldingAdvice({ notify: false, force: true });
      head.querySelector('#holdCheckBtn').disabled = false;
      const alerts = (data && data.items ? data.items : [])
        .filter((x) => x.advice && x.advice.level === 'alert')
        .map((x) => ({ code: x.code, name: x.name, ...x.advice }));
      if (alerts.length) showAlert(alerts, '手动检查结果');
      else toast('现在没有需要动手的信号');
      if (state.tab === 'holding') render();
    });

    if (!state.holdings.length) {
      list.appendChild(emptyNode('还没有持仓，上面搜一只加进来试试'));
      return;
    }

    if (!state.holdingAdvice) {
      list.appendChild(loadingNode('正在按分时价和计划算建议…'));
      await refreshHoldingAdvice({ notify: false, first: true });
      if (state.tab !== 'holding') return;
      list.innerHTML = '';
      list.appendChild(head);
    }

    const map = new Map((state.holdingAdvice && state.holdingAdvice.items ? state.holdingAdvice.items : [])
      .map((x) => [x.code, x]));
    state.holdings.forEach((h) => list.appendChild(holdingCard(h, map.get(h.code))));
  }

  /* ---------------------- 持仓提醒（弹窗 + 提示声） ---------------------- */

  async function refreshHoldingAdvice({ notify = true, force = false, first = false } = {}) {
    if (!state.holdings.length) {
      state.holdingAdvice = null;
      return null;
    }
    let data = null;
    try {
      data = await api('/api/holdings/advice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cash: state.holdCash,
          items: state.holdings.map((h) => ({ code: h.code, shares: h.shares, cost: h.cost })),
        }),
      });
    } catch (err) {
      if (!notify) return null;
      toast(`持仓行情拉取失败：${err.message}`);
      return null;
    }

    state.holdingAdvice = data;
    const alerts = [];
    for (const it of data.items || []) {
      const adv = it.advice || {};
      const key = `${it.code}:${adv.action}:${adv.lot}`;
      const changed = state.adviceKeys[it.code] !== key;
      state.adviceKeys[it.code] = key;
      if (changed && adv.level === 'alert') {
        alerts.push({ code: it.code, name: it.name, ...adv });
      }
    }

    const firstRun = first || !state.adviceReady;
    state.adviceReady = true;
    if (force && alerts.length) showAlert(alerts, '持仓提醒');
    else if (!firstRun && notify && alerts.length) showAlert(alerts, '持仓提醒');
    return data;
  }

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!beep._ctx) beep._ctx = new Ctx();
      const ctx = beep._ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      [0, 0.2].forEach((offset, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = i === 0 ? 880 : 1240;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.2);
      });
    } catch (_) {
      /* 没声音也不能影响提醒 */
    }
  }

  function showAlert(list, title) {
    const overlay = $('#alertOverlay');
    const body = $('#alertBody');
    if (!overlay || !body) return;
    $('#alertTitle').textContent = title || '持仓提醒';
    body.innerHTML = list.map((a) => {
      const isAdd = a.action === 'add';
      return `<div class="alert-item">
        <div class="ai-head">
          <b>${esc(a.name || '')} <span class="stock-code">${esc(a.code)}</span></b>
          <span class="badge ${isAdd ? 'hot' : 'cold'}">${esc(a.actionText || '')}</span>
        </div>
        <div class="ai-line">现价 ${num(a.price)}${
          Number.isFinite(a.profitPct) ? ` ｜ 浮动盈亏 <span class="${pctClass(a.profitPct)}">${pctText(a.profitPct)}</span>` : ''
        }</div>
        ${a.lot > 0
          ? `<div class="ai-line"><b>${isAdd ? '建议加仓' : '建议卖出'} ${a.lot} 股</b>（约 ${money(a.amount)} 元）</div>`
          : ''}
        <ul class="plain">${(a.reasons || []).slice(0, 3).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      </div>`;
    }).join('');
    overlay.hidden = false;
    beep();
    toast(`${list.length} 只持仓出现信号，点弹窗看详情`, 5000);
  }

  function isTradingTime(d = new Date()) {
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const m = d.getHours() * 60 + d.getMinutes();
    return (m >= 9 * 60 + 15 && m <= 11 * 60 + 35) || (m >= 12 * 60 + 55 && m <= 15 * 60 + 5);
  }

  function initHoldingMonitor() {
    const tick = async () => {
      if (!state.holdings.length) return;
      await refreshHoldingAdvice({ notify: isTradingTime() });
      if (state.tab === 'holding') render();
    };
    setTimeout(() => { tick().catch(() => {}); }, 25 * 1000);
    setInterval(() => { tick().catch(() => {}); }, HOLDING_POLL_MS);
  }

  /* ---------------------- 搜股票 ---------------------- */

  let searchTimer = null;

  function searchRow(item) {
    const row = el('div', 'search-item');
    const code = esc(item.code);
    const holdingMode = state.tab === 'holding';
    const added = holdingMode ? isHeld(item.code) : isWatched(item.code);
    const addText = holdingMode
      ? (added ? '已在持仓' : '加入持仓')
      : (added ? '已在自选' : '加入自选');
    row.innerHTML =
      `<div class="si-main" title="点击查看这只票的完整分析">
         <span class="stock-name">${esc(item.name || item.code)}</span>
         <span class="stock-code">${code}</span>
         ${item.mainBoard ? '' : '<span class="tag">非主板</span>'}
       </div>
       <div class="si-num ${pctClass(item.changePct)}">${num(item.price)}<span class="sub">${pctText(item.changePct)}</span></div>
       <button class="btn ${added ? 'ghost' : 'primary'} si-add" ${added ? 'disabled' : ''}>${addText}</button>`;

    row.querySelector('.si-main').addEventListener('click', () => openDetail(item.code, item));
    row.querySelector('.si-add').addEventListener('click', () => {
      if (added) return;
      if (holdingMode) {
        addHolding(item.code, item.name || item.code);
        toast(`已加入持仓：${item.name || item.code}，填上持股数和成本我就开始盯`);
        state.searchQ = '';
        $('#searchInput').value = '';
        render();
      } else {
        toggleWatch(item.code, item.name || item.code); // 内部会 render()，自选和按钮状态一起刷新
      }
    });
    return row;
  }

  function renderSearchResults(data) {
    const box = $('#searchResults');
    if (!box) return;
    if (!state.searchQ) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    const items = data && data.q === state.searchQ ? data.items || [] : [];
    if (!items.length) {
      box.innerHTML =
        `<div class="search-empty">没找到「${esc(state.searchQ)}」。只支持 A 股：` +
        '可以输代码（600519）、名称（贵州茅台）或拼音首字母（gzmt）。</div>';
      return;
    }
    box.innerHTML = '';
    items.forEach((it) => box.appendChild(searchRow(it)));
  }

  async function doSearch(q) {
    state.searchQ = q;
    const box = $('#searchResults');
    if (!box) return;
    if (!q) {
      state.search = null;
      box.hidden = true;
      box.innerHTML = '';
      return;
    }

    box.hidden = false;
    box.innerHTML = '<div class="search-empty">搜索中…</div>';

    let data = null;
    try {
      data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    } catch (err) {
      if (state.searchQ !== q) return;
      state.search = null;
      box.innerHTML = `<div class="search-empty">搜索失败：${esc(err.message)}</div>`;
      return;
    }
    if (state.searchQ !== q) return; // 关键词已经变了，丢弃这次结果
    state.search = data;
    renderSearchResults(data);
  }

  function initSearch() {
    const input = $('#searchInput');
    if (!input) return;
    const run = () => doSearch(input.value.trim());
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(run, 350);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchTimer);
        run();
      } else if (e.key === 'Escape') {
        input.value = '';
        doSearch('');
      }
    });
    $('#searchBtn').addEventListener('click', () => {
      clearTimeout(searchTimer);
      run();
    });
  }

  /* ---------------------- 我的模拟盘 ---------------------- */

  const STATUS_CLASS = {
    建仓: 'buy',
    加仓: 'buy',
    调仓: 'swap',
    减仓: 'sell',
    持有: 'hold',
    空仓: 'idle',
    休市: 'idle',
  };

  async function loadPortfolio(force) {
    if (state.loadingPortfolio) return;
    state.loadingPortfolio = true;
    state.portfolioError = null;
    if (state.tab === 'portfolio' && !state.portfolio) renderPortfolio();
    try {
      state.portfolio = await api('/api/portfolio', force ? { method: 'POST' } : undefined);
      if (state.tab === 'portfolio') renderPortfolio();
    } catch (err) {
      state.portfolioError = err.message;
      if (state.tab === 'portfolio') renderPortfolio();
    } finally {
      state.loadingPortfolio = false;
    }
  }

  function renderPortfolio() {
    const list = $('#list');
    $('#catHead').hidden = false;
    $('#catTitle').textContent = '我的模拟盘';
    $('#listHead').innerHTML = '';
    const d = state.portfolio;

    if (!d) {
      $('#catHeadline').textContent = state.portfolioError
        ? `模拟盘读取失败：${state.portfolioError}`
        : '正在按今天的行情跑一遍买卖决策…';
      $('#catMethod').innerHTML = '';
      list.innerHTML = '';
      if (state.portfolioError) {
        list.appendChild(emptyNode('暂时读不到模拟盘数据，点上面的「刷新」或稍后再试。'));
      } else {
        list.appendChild(loadingNode('第一次打开会抓一遍全市场行情，大约 15 秒…'));
      }
      return;
    }

    const a = d.account || {};
    $('#catHeadline').innerHTML =
      `给我 10 万本金做模拟炒股，从 <b>${esc(d.profile.startDate)}</b> 开始逐日记账：` +
      `每天只判断一次买／卖／继续持有，并把理由写在下面。数据更新时间 ${esc(
        new Date(d.at).toLocaleString('zh-CN', { hour12: false }),
      )}。`;
    $('#catMethod').innerHTML =
      '这个模拟盘只做沪深主板，完全按 A 股真实交易规则撮合：T+1、100 股一手、涨停不追、跌停不卖、' +
      '佣金／印花税／过户费都照实扣。<br><br>' +
      '<b>账实一致性：</b>现金和持仓不是"每天拍脑袋写"的，而是把每一天的成交流水按顺序重放算出来的，' +
      '所以 总资产 ＝ 现金 + 持仓市值 永远成立，日与日之间的净值也接得上。<br><br>' +
      '<b>免责：</b>这是规则化模拟盘，不构成投资建议，也不保证收益。<br><br>' +
      `<b>交易规则：</b><ul class="plain pf-rules-inline">${(d.rules || [])
        .map((r) => `<li>${esc(r)}</li>`)
        .join('')}</ul>`;

    list.innerHTML = '';

    /* 操作按钮 */
    const actions = el('div', 'pf-actions');
    const btnRun = el('button', 'btn primary', '看盘并记录今天');
    btnRun.addEventListener('click', async () => {
      btnRun.disabled = true;
      btnRun.textContent = '正在跑今日流程…';
      await loadPortfolio(true);
      btnRun.disabled = false;
      btnRun.textContent = '看盘并记录今天';
      toast('已按最新行情更新今天的记录');
    });
    const btnReset = el('button', 'btn ghost', '清空重来（回到 10 万本金）');
    btnReset.addEventListener('click', async () => {
      if (!window.confirm('确定清空所有模拟盘记录、回到 10 万本金重新开始吗？')) return;
      try {
        await api('/api/portfolio/reset', { method: 'POST' });
        state.portfolio = null;
        toast('已重置，明天开盘重新开始记录');
        await loadPortfolio(true);
      } catch (err) {
        toast(`重置失败：${err.message}`);
      }
    });
    actions.appendChild(btnRun);
    actions.appendChild(btnReset);
    actions.appendChild(
      el(
        'span',
        'pf-hint',
        d.session && d.session.trading
          ? `今天开市中，记录用的是${esc(d.session.priceSourceText || d.session.priceSource)}`
          : '今天休市，账户按最近收盘价估值',
      ),
    );
    list.appendChild(actions);

    /* 关键数字 */
    const stats = [
      { k: '总资产', v: money(a.totalAssets), sub: `起始本金 ${money(d.profile.initialCapital, 0)}元`, cls: '' },
      { k: '累计盈亏', v: signedMoney(a.cumPnl), sub: pctText(a.cumPnlPct), cls: pctClass(a.cumPnl) },
      { k: '当日盈亏', v: signedMoney(a.dayPnl), sub: pctText(a.dayPnlPct), cls: pctClass(a.dayPnl) },
      { k: '可用资金', v: money(a.cash), sub: `仓位 ${a.positionRatio}%`, cls: '' },
      {
        k: '持仓市值',
        v: money(a.marketValue),
        sub: `浮动盈亏 ${signedMoney(a.unrealizedPnl)}`,
        cls: pctClass(a.unrealizedPnl),
      },
      { k: '净值 / 最大回撤', v: `${a.nav}`, sub: `回撤 ${a.drawdownPct}%`, cls: '' },
      { k: '记录天数', v: `${a.days} 天`, sub: `交易日 ${a.tradeDays} 天`, cls: '' },
      {
        k: '当前持仓',
        v: `${(d.holdings || []).length} / ${d.profile.maxPositions}`,
        sub: (d.holdings || []).length ? '按纪律跟踪' : '空仓等机会',
        cls: '',
      },
    ];
    const statBox = el('div', 'pf-stats');
    stats.forEach((s) => {
      statBox.appendChild(
        el('div', 'pf-stat', `<div class="k">${s.k}</div><div class="v ${s.cls}">${s.v}</div><div class="s">${s.sub}</div>`),
      );
    });
    list.appendChild(statBox);

    /* 今日记录 */
    if (d.today) list.appendChild(portfolioTodayCard(d));

    /* 净值曲线 */
    const eqCard = el('div', 'card');
    eqCard.innerHTML =
      `<h3>净值曲线 <span class="badge">${(d.equity || []).length} 个记录点</span></h3>` +
      '<div class="chart-box"><canvas id="equityCanvas"></canvas></div>' +
      '<div class="chart-legend"><span style="color:#4f8cff">— 总资产</span>' +
      '<span style="color:#f0a33a">— 本金基准线</span><span>横轴为记录日期</span></div>';
    list.appendChild(eqCard);

    list.appendChild(portfolioHoldingsCard(d));
    list.appendChild(portfolioJournalCard(d));
    list.appendChild(portfolioTradesCard(d));
    list.appendChild(
      el(
        'div',
        'card',
        `<h3>交易规则</h3><ul class="plain">${(d.rules || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`,
      ),
    );

    requestAnimationFrame(() => {
      const c = document.getElementById('equityCanvas');
      if (c) window.Charts.drawEquity(c, d.equity || [], d.profile.initialCapital);
    });
  }

  /** 今日这条记录：一句话结论 + 要点 + 当天成交 + 持仓 */
  function portfolioTodayCard(d) {
    const e = d.today;
    const card = el('div', 'card pf-today');
    const trades = e.trades || [];
    const positions = e.positions || [];

    const tradesHtml = trades.length
      ? `<div class="pf-sub">当天成交</div>${trades
          .map(
            (t) => `<div class="pf-trade ${t.side}">
              <span class="pf-tag">${t.side === 'buy' ? '买入' : '卖出'}</span>
              <span class="pf-trade-name">${esc(t.name)} <span class="stock-code">${esc(t.code)}</span></span>
              <span class="pf-trade-num">${t.shares} 股 @ ${num(t.price)}</span>
              <span class="pf-trade-num">金额 ${money(t.amount)}</span>
              <span class="pf-trade-num">费用 ${money(t.fee)}</span>
              <span class="pf-trade-reason">${esc(t.reason || '')}</span>
            </div>`,
          )
          .join('')}`
      : '<div class="pf-sub">当天成交</div><div class="ev-impact">今天没有任何成交，不产生费用。</div>';

    const posHtml = positions.length
      ? `<div class="pf-sub">收盘持仓</div><table class="pf-table compact">
          <thead><tr><th>股票</th><th class="num">持仓</th><th class="num">成本</th><th class="num">现价</th>
          <th class="num">市值</th><th class="num">浮动盈亏</th><th>下一步</th></tr></thead>
          <tbody>${positions
            .map(
              (p) => `<tr>
                <td>${esc(p.name)} <span class="stock-code">${esc(p.code)}</span></td>
                <td class="num">${p.shares}</td>
                <td class="num">${num(p.cost)}</td>
                <td class="num ${pctClass(p.changePct)}">${num(p.last)}</td>
                <td class="num">${money(p.marketValue)}</td>
                <td class="num ${pctClass(p.floatPnl)}">${signedMoney(p.floatPnl)}（${pctText(p.floatPnlPct)}）</td>
                <td class="pf-note">${esc(p.nextAction || p.note || '')}</td>
              </tr>`,
            )
            .join('')}</tbody></table>`
      : `<div class="pf-sub">收盘持仓</div><div class="ev-impact">空仓中，现金 ${money(
          e.cash,
        )} 元全额待命。</div>`;

    const candHtml = (e.candidates || []).length
      ? `<div class="pf-sub">当日候选池（决定买谁／为什么不买）</div><div class="pf-cands">${e.candidates
          .map(
            (c) => `<span class="pf-cand ${c.status === '已买入' ? 'on' : ''}">
              <b>${esc(c.name)}</b> <span class="stock-code">${esc(c.code)}</span>
              <span class="pf-cand-status">${esc(c.status)}</span>
              <span class="pf-cand-num">现价 ${c.price === null ? '-' : num(c.price)}／买区 ${esc(c.zone || '-')}／评分 ${c.score}</span>
            </span>`,
          )
          .join('')}</div>`
      : '';

    card.innerHTML =
      `<h3>今日记录 <span class="badge">${esc(e.date)} ${esc(e.weekday)}</span>
         <span class="pf-status ${STATUS_CLASS[e.status] || ''}">${esc(e.status)}</span>
         <span class="badge">${esc(e.priceSourceText || e.priceSource || '')}</span></h3>
       <div class="pf-headline">${esc(e.summary || '')}</div>
       <ul class="plain">${(e.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
       ${tradesHtml}${posHtml}${candHtml}`;
    return card;
  }

  /** 当前持仓明细表 */
  function portfolioHoldingsCard(d) {
    const rows = d.holdings || [];
    const card = el('div', 'card');
    if (!rows.length) {
      card.innerHTML =
        '<h3>当前持仓</h3><div class="ev-impact">现在空仓。没有合适的买点就不出手，现金也是一种仓位。</div>';
      return card;
    }
    const total = d.account && d.account.totalAssets ? d.account.totalAssets : 0;
    card.innerHTML =
      `<h3>当前持仓 <span class="badge">${rows.length} / ${d.profile.maxPositions} 只</span></h3>
       <table class="pf-table">
         <thead><tr>
           <th>股票</th><th class="num">持仓</th><th class="num">成本</th><th class="num">现价</th>
           <th class="num">当日</th><th class="num">市值</th><th class="num">浮动盈亏</th>
           <th class="num">占总资产</th><th class="num">持有</th><th>下一步</th>
         </tr></thead>
         <tbody>${rows
           .map(
             (p) => `<tr class="pf-row" data-code="${esc(p.code)}">
               <td>${esc(p.name)} <span class="stock-code">${esc(p.code)}</span></td>
               <td class="num">${p.shares}</td>
               <td class="num">${num(p.cost)}</td>
               <td class="num ${pctClass(p.changePct)}">${num(p.last)}</td>
               <td class="num ${pctClass(p.changePct)}">${pctText(p.changePct)}</td>
               <td class="num">${money(p.marketValue)}</td>
               <td class="num ${pctClass(p.floatPnl)}">${signedMoney(p.floatPnl)}（${pctText(p.floatPnlPct)}）</td>
               <td class="num">${total ? ((p.marketValue / total) * 100).toFixed(1) : '-'}%</td>
               <td class="num">${p.heldDays} 天</td>
               <td class="pf-note">${esc(p.nextAction || p.note || '')}</td>
             </tr>`,
           )
           .join('')}</tbody>
       </table>
       <div class="pf-hint">点任意一行可以看这只票的分时与日线。</div>`;
    card.querySelectorAll('.pf-row').forEach((tr) => {
      tr.addEventListener('click', () => openDetail(tr.dataset.code, null));
    });
    return card;
  }

  /** 每日操作记录（倒序，可展开） */
  function portfolioJournalCard(d) {
    const entries = d.journal || [];
    const card = el('div', 'card');
    card.innerHTML =
      `<h3>每日操作记录 <span class="badge">共 ${entries.length} 天</span>` +
      '<span class="pf-hint">按日期倒序，点开看当天的买卖、持仓和我的判断</span></h3>';
    if (!entries.length) {
      card.appendChild(el('div', 'ev-impact', '还没有记录。'));
      return card;
    }
    const wrap = el('div', 'pf-days');
    entries.slice(0, 90).forEach((e, i) => wrap.appendChild(portfolioDay(e, i === 0, d)));
    card.appendChild(wrap);
    return card;
  }

  function portfolioDay(e, open, d) {
    const node = el('details', 'pf-day');
    if (open) node.open = true;
    const buys = (e.trades || []).filter((t) => t.side === 'buy');
    const sells = (e.trades || []).filter((t) => t.side === 'sell');

    const tradesHtml = e.trades && e.trades.length
      ? `<div class="pf-sub">成交</div>${e.trades
          .map(
            (t) => `<div class="pf-trade ${t.side}">
              <span class="pf-tag">${t.side === 'buy' ? '买入' : '卖出'}</span>
              <span class="pf-trade-name">${esc(t.name)} <span class="stock-code">${esc(t.code)}</span></span>
              <span class="pf-trade-num">${t.shares} 股 @ ${num(t.price)}</span>
              <span class="pf-trade-num">金额 ${money(t.amount)}</span>
              <span class="pf-trade-num">费用 ${money(t.fee)}</span>
              <span class="pf-trade-reason">${esc(t.reason || '')}</span>
            </div>`,
          )
          .join('')}`
      : '<div class="pf-sub">成交</div><div class="ev-impact">当天没有买卖，未产生任何费用。</div>';

    const posHtml = (e.positions || []).length
      ? `<div class="pf-sub">持仓</div><table class="pf-table compact">
          <thead><tr><th>股票</th><th class="num">持仓</th><th class="num">成本</th><th class="num">收盘</th>
          <th class="num">市值</th><th class="num">浮动盈亏</th><th>下一步</th></tr></thead>
          <tbody>${e.positions
            .map(
              (p) => `<tr>
                <td>${esc(p.name)} <span class="stock-code">${esc(p.code)}</span></td>
                <td class="num">${p.shares}</td>
                <td class="num">${num(p.cost)}</td>
                <td class="num">${num(p.last)}</td>
                <td class="num">${money(p.marketValue)}</td>
                <td class="num ${pctClass(p.floatPnl)}">${signedMoney(p.floatPnl)}（${pctText(p.floatPnlPct)}）</td>
                <td class="pf-note">${esc(p.nextAction || p.note || '')}</td>
              </tr>`,
            )
            .join('')}</tbody></table>`
      : '';

    const candHtml = (e.candidates || []).length
      ? `<details class="pf-cand-box"><summary>候选池观察 ${e.candidates.length} 只</summary>
          <div class="pf-cands">${e.candidates
            .map(
              (c) => `<span class="pf-cand ${c.status === '已买入' ? 'on' : ''}">
                <b>${esc(c.name)}</b> <span class="stock-code">${esc(c.code)}</span>
                <span class="pf-cand-status">${esc(c.status)}</span>
                <span class="pf-cand-num">现价 ${c.price === null ? '-' : num(c.price)}／买区 ${esc(c.zone || '-')}／评分 ${c.score}</span>
              </span>`,
            )
            .join('')}</div></details>`
      : '';

    node.innerHTML =
      `<summary>
         <span class="pf-date">${esc(e.date)}<span class="pf-wd">${esc(e.weekday)}</span></span>
         <span class="pf-status ${STATUS_CLASS[e.status] || ''}">${esc(e.status)}</span>
         <span class="pf-sum">${esc(e.summary || '')}</span>
         <span class="pf-metrics">
           <span>总资产 ${money(e.totalAssets)}</span>
           <span class="${pctClass(e.dayPnl)}">当日 ${signedMoney(e.dayPnl)}（${pctText(e.dayPnlPct)}）</span>
           <span class="${pctClass(e.cumPnlPct)}">累计 ${pctText(e.cumPnlPct)}</span>
           <span>仓位 ${e.positionRatio}%</span>
           ${buys.length ? `<span class="up">买 ${buys.length}</span>` : ''}
           ${sells.length ? `<span class="down">卖 ${sells.length}</span>` : ''}
         </span>
       </summary>
       <div class="pf-body">
         <ul class="plain">${(e.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
         ${tradesHtml}${posHtml}${candHtml}
         <div class="pf-foot">价格口径：${esc(e.priceSourceText || e.priceSource || '-')}${
        e.backfilled ? ' · 当天没运行程序，按收盘价补记' : ''
      }</div>
       </div>`;
    return node;
  }

  /** 全部成交流水 */
  function portfolioTradesCard(d) {
    const trades = d.trades || [];
    const card = el('div', 'card');
    if (!trades.length) {
      card.innerHTML = '<h3>成交流水</h3><div class="ev-impact">还没有成交记录。</div>';
      return card;
    }
    card.innerHTML =
      `<h3>成交流水 <span class="badge">${trades.length} 笔</span></h3>
       <table class="pf-table compact">
         <thead><tr><th>日期</th><th>方向</th><th>股票</th><th class="num">价格</th><th class="num">数量</th>
         <th class="num">金额</th><th class="num">费用</th><th>理由</th></tr></thead>
         <tbody>${trades
           .map(
             (t) => `<tr>
               <td class="num">${esc(t.date)}</td>
               <td><span class="pf-tag ${t.side}">${t.side === 'buy' ? '买入' : '卖出'}</span></td>
               <td>${esc(t.name)} <span class="stock-code">${esc(t.code)}</span></td>
               <td class="num">${num(t.price)}</td>
               <td class="num">${t.shares}</td>
               <td class="num">${money(t.amount)}</td>
               <td class="num">${money(t.fee)}</td>
               <td class="pf-note">${esc(t.reason || '')}</td>
             </tr>`,
           )
           .join('')}</tbody>
       </table>`;
    return card;
  }

  /* ---------------------- 详情 ---------------------- */

  async function openDetail(code, item) {
    state.detailCode = code;
    const drawer = $('#detail');
    const scrim = $('#scrim');
    drawer.hidden = false;
    scrim.hidden = false;
    const inner = $('#detailInner');
    inner.innerHTML = '';
    inner.appendChild(loadingNode('正在加载分时与日线…'));

    let data = state.detailCache.get(code);
    if (!data) {
      try {
        data = await api(`/api/stock/${code}`);
        state.detailCache.set(code, data);
      } catch (err) {
        inner.innerHTML = '';
        inner.appendChild(emptyNode(`加载失败：${err.message}`));
        return;
      }
    }
    renderDetail(inner, code, item, data);
    document.querySelectorAll('.row').forEach((r) => r.classList.toggle('active', r.dataset.code === code));
  }

  function closeDetail() {
    state.detailCode = null;
    $('#detail').hidden = true;
    $('#scrim').hidden = true;
    document.querySelectorAll('.row').forEach((r) => r.classList.remove('active'));
  }

  const insightCache = new Map();

  function insightHtml(d) {
    if (!d || !d.ok) {
      return `<div class="ev-impact">${esc((d && d.reason) || '历史数据不足，暂时算不出规律')}</div>`;
    }

    const strip = (d.months || []).map((m) => {
      const v = Number(m.avgPct);
      const cls = !m.total ? 'flat' : v >= 0.8 ? 'up' : v <= -0.8 ? 'down' : 'flat';
      const h = Math.max(6, Math.min(40, Math.abs(v || 0) * 5 + 6));
      const tip = m.total
        ? `${m.name} 历史平均 ${v > 0 ? '+' : ''}${num(v)}%，${m.up}/${m.total} 年上涨`
        : `${m.name} 样本不足`;
      return `<div class="month-cell" title="${esc(tip)}">
        <i class="${cls}" style="height:${h}px"></i><span>${m.month}</span>
        <b class="${cls}">${m.total ? (v > 0 ? '+' : '') + num(v, 1) : '—'}</b>
      </div>`;
    }).join('');

    const cur = d.current || {};
    const next = d.next || {};
    return `
      <div class="kv-grid" style="margin-bottom:10px">
        <div class="kv"><span class="k">样本区间</span><span>${esc(d.from)} ~ ${esc(d.to)}（${d.years} 年）</span></div>
        <div class="kv"><span class="k">历史位置</span><span>${num(d.position && d.position.pct, 1)}% 分位</span></div>
        <div class="kv"><span class="k">日均波动</span><span>${num(d.volatility && d.volatility.avgDailyMove)}%</span></div>
        <div class="kv"><span class="k">本月 / 下月</span><span>${esc(cur.name || '-')} ${num(cur.avgPct)}% ｜ ${esc(
          next.name || '-',
        )} ${num(next.avgPct)}%</span></div>
      </div>
      <div class="month-strip">${strip}</div>
      <ul class="plain">${(d.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
  }

  async function loadInsight(code) {
    let data = insightCache.get(code);
    if (!data) {
      try {
        data = await api(`/api/insight/${code}`);
        insightCache.set(code, data);
      } catch (err) {
        const box = document.getElementById('insightBody');
        if (box && state.detailCode === code) box.innerHTML = `历史规律加载失败：${esc(err.message)}`;
        return;
      }
    }
    const box = document.getElementById('insightBody');
    if (!box || state.detailCode !== code) return;
    box.classList.remove('ev-impact');
    box.innerHTML = insightHtml(data);
  }

  function renderDetail(inner, code, item, data) {
    inner.innerHTML = '';
    const q = data.quote || {};
    const tech = data.tech || {};
    const plan = (item && item.plan) || data.plan || {};
    const name = (item && item.name) || q.name || code;

    /* 头部 */
    const head = el('div', 'detail-head');
    head.innerHTML =
      `<div>
         <div class="detail-title">
           <h2>${name}</h2><span class="stock-code">${code}</span>
           ${item ? `<span class="badge hot">${item.categoryName}</span>` : ''}
           ${item && item.score ? `<span class="badge">评分 ${num(item.score, 1)}</span>` : ''}
         </div>
         <div class="detail-price">
           <span class="big ${pctClass(q.changePct)}">${num(q.price)}</span>
           <span class="${pctClass(q.changePct)}">${pctText(q.changePct)}</span>
           <span class="stock-code">成交 ${yi(q.amount)} · 换手 ${num(q.turnoverRate)}% · 量比 ${
             num(q.volumeRatio) === 'NaN' ? '-' : num(q.volumeRatio)
           }</span>
         </div>
       </div>`;
    const actions = el('div', '');
    const star = el('button', `star ${isWatched(code) ? 'on' : ''}`, isWatched(code) ? '★' : '☆');
    star.dataset.code = code;
    star.title = '加入/移出自选';
    star.addEventListener('click', () => {
      toggleWatch(code, name);
      star.textContent = isWatched(code) ? '★' : '☆';
      star.classList.toggle('on', isWatched(code));
    });
    const close = el('button', 'close-btn', '✕');
    close.addEventListener('click', closeDetail);
    actions.appendChild(star);
    actions.appendChild(close);
    head.appendChild(actions);
    inner.appendChild(head);

    /* 交易计划 */
    if (plan && plan.buyZone) {
      const card = el('div', 'card');
      const t1 = plan.targets && plan.targets[0];
      const t2 = plan.targets && plan.targets[1];
      card.innerHTML =
        `<h3>交易计划 <span class="badge">${plan.category} · ${plan.horizon}</span></h3>
         <div class="plan-grid">
           <div class="plan-cell"><div class="k">建议买入区间</div><div class="v">${num(plan.buyZone.low)} - ${num(
             plan.buyZone.high,
           )}</div></div>
           <div class="plan-cell"><div class="k">止损价</div><div class="v down">${num(plan.stopLoss)}</div>
             <div class="k">较买入价 ${num(plan.stopLossPct)}%</div></div>
           <div class="plan-cell"><div class="k">目标一</div><div class="v up">${num(t1 && t1.price)}</div>
             <div class="k">${t1 ? `+${num(t1.pct)}%` : ''}</div></div>
           <div class="plan-cell"><div class="k">目标二</div><div class="v up">${num(t2 && t2.price)}</div>
             <div class="k">${t2 ? `+${num(t2.pct)}%` : ''}</div></div>
         </div>
         <div class="plan-note">${plan.planText || ''}</div>
         <div class="kv-grid" style="margin-top:12px">
           <div class="kv"><span class="k">建议仓位上限</span><span>${plan.positionPct}%</span></div>
           <div class="kv"><span class="k">盈亏比</span><span>${num(plan.riskReward, 2)}</span></div>
           <div class="kv"><span class="k">估算胜率</span><span>${num(plan.winRate, 1)}%</span></div>
           <div class="kv"><span class="k">期望收益</span><span class="${pctClass(plan.expectedPct)}">${pctText(
             plan.expectedPct,
           )}</span></div>
           <div class="kv"><span class="k">ATR(14)</span><span>${num(plan.atr)}</span></div>
           <div class="kv"><span class="k">数据源</span><span>${data.kline ? data.kline.source || '-' : '-'}</span></div>
         </div>
         <h3 style="margin-top:14px">什么时候卖（按纪律执行）</h3>
         <ul class="plain">${(plan.sellRules || []).map((r) => `<li>${r}</li>`).join('')}</ul>`;
      inner.appendChild(card);
    } else {
      inner.appendChild(el('div', 'card', '<h3>交易计划</h3><div class="ev-impact">数据不足，无法生成计划</div>'));
    }

    /* 我的看法：历史规律（异步统计，不挡其他内容） */
    const insightCard = el('div', 'card');
    insightCard.innerHTML =
      '<h3>我的看法（历史规律） <span class="badge">按历史日线统计</span></h3>' +
      '<div id="insightBody" class="ev-impact">正在统计这只票的历史季节性…</div>';
    inner.appendChild(insightCard);
    loadInsight(code);

    /* 分时 */
    const trendCard = el('div', 'card');
    trendCard.innerHTML = `<h3>当日分时 <span class="badge">${
      (data.trends && data.trends.source) || '-'
    }</span></h3><div class="chart-box"><canvas id="trendCanvas"></canvas></div>
      <div class="chart-legend"><span style="color:#4f8cff">— 价格</span><span style="color:#f0a33a">— 均价</span>
      <span>虚线为昨收 ${num(data.trends && data.trends.preClose)}</span></div>`;
    inner.appendChild(trendCard);

    /* 日线 */
    const kCard = el('div', 'card');
    kCard.innerHTML = `<h3>日线（前复权，近 90 个交易日）</h3>
      <div class="chart-box"><canvas id="kCanvas"></canvas></div>
      <div class="chart-legend">
        <span style="color:#ffffff">— MA5</span><span style="color:#f0c53a">— MA10</span>
        <span style="color:#c07bf0">— MA20</span><span>红涨绿跌</span>
      </div>`;
    inner.appendChild(kCard);

    /* 选股理由 / 风险 */
    if (item) {
      const card = el('div', 'card');
      card.innerHTML =
        `<h3>入选理由</h3><ul class="plain">${(item.reasons || []).map((r) => `<li>${r}</li>`).join('')}</ul>` +
        ((item.risks || []).length
          ? `<h3 style="margin-top:14px">风险提示</h3><ul class="risks">${item.risks
              .map((r) => `<li>${r}</li>`)
              .join('')}</ul>`
          : '');
      inner.appendChild(card);
    }

    /* 技术指标 */
    const techCard = el('div', 'card');
    techCard.innerHTML = `<h3>技术位置</h3>
      <div class="kv-grid">
        <div class="kv"><span class="k">MA5</span><span>${num(tech.ma5)}</span></div>
        <div class="kv"><span class="k">MA10</span><span>${num(tech.ma10)}</span></div>
        <div class="kv"><span class="k">MA20</span><span>${num(tech.ma20)}</span></div>
        <div class="kv"><span class="k">距 5 日线</span><span class="${pctClass(tech.priceVsMa5Pct)}">${pctText(
          tech.priceVsMa5Pct,
        )}</span></div>
        <div class="kv"><span class="k">60 日区间位置</span><span>${
          Number.isFinite(tech.position) ? `${Math.round(tech.position * 100)}%` : '-'
        }</span></div>
        <div class="kv"><span class="k">近 20 日高</span><span>${num(tech.high20)}</span></div>
        <div class="kv"><span class="k">近 20 日低</span><span>${num(tech.low20)}</span></div>
        <div class="kv"><span class="k">近 5 日涨幅</span><span class="${pctClass(tech.chg5Pct)}">${pctText(
          tech.chg5Pct,
        )}</span></div>
        <div class="kv"><span class="k">ATR 波动</span><span>${num(tech.atrPct)}%</span></div>
      </div>`;
    inner.appendChild(techCard);

    /* 基本面（公司经营 + 股东结构） */
    renderFundamentalCard(inner, data, item);

    /* 资金流 */
    if (data.flow && data.flow.length) {
      const card = el('div', 'card');
      const recent = data.flow.slice(-6);
      card.innerHTML = `<h3>近 ${recent.length} 日主力资金</h3>
        <div class="kv-grid">${recent
          .map(
            (f) =>
              `<div class="kv"><span class="k">${f.date.slice(5)}</span><span class="${pctClass(
                f.mainNetIn,
              )}">${yi(f.mainNetIn)}</span></div>`,
          )
          .join('')}</div>`;
      inner.appendChild(card);
    }

    /* 消息 / 证据 */
    const evidence = (item && item.evidence) || [];
    const anns = (data.announcements || []).slice(0, 6);
    const news = (data.news || []).slice(0, 5);
    if (evidence.length || anns.length || news.length) {
      const card = el('div', 'card');
      let html = '<h3>相关公告与消息</h3>';
      if (evidence.length) {
        html += evidence
          .map(
            (e) => `<div class="evi">
              <div class="t"><span class="lvl">${e.level || ''}</span>${
                e.url ? `<a href="${e.url}" target="_blank">${e.title}</a>` : e.title
              }</div>
              <div class="m">${e.label || ''} · ${e.date || e.time || ''} · ${e.source || ''}</div>
            </div>`,
          )
          .join('');
      }
      if (anns.length) {
        html += anns
          .map(
            (a) => `<div class="evi">
              <div class="t">${a.url ? `<a href="${a.url}" target="_blank">${a.title}</a>` : a.title}</div>
              <div class="m">交易所公告 · ${a.date}${a.columns && a.columns.length ? ` · ${a.columns.join('/')}` : ''}</div>
            </div>`,
          )
          .join('');
      }
      if (news.length) {
        html += news
          .map(
            (n) => `<div class="evi">
              <div class="t">${n.url ? `<a href="${n.url}" target="_blank">${n.title}</a>` : n.title}</div>
              <div class="m">${n.source || '新闻'} · ${n.time || ''}</div>
            </div>`,
          )
          .join('');
      }
      card.innerHTML = html;
      inner.appendChild(card);
    }

    /* 画图（等布局完成后再画，才能拿到正确的 canvas 宽度） */
    requestAnimationFrame(() => {
      const tc = inner.querySelector('#trendCanvas');
      const kc = inner.querySelector('#kCanvas');
      if (tc) window.Charts.drawTrends(tc, data.trends);
      if (kc) window.Charts.drawKline(kc, data.kline && data.kline.bars);
    });
  }

  /* ---------------------- 基本面卡片 ---------------------- */

  function wan(v, digits = 2) {
    if (!Number.isFinite(v)) return '-';
    if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(digits)}亿`;
    if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(digits)}万户`;
    return `${v.toFixed(0)}户`;
  }

  function yuan(v, digits = 1) {
    if (!Number.isFinite(v)) return '-';
    if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
    if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(digits)}万`;
    return v.toFixed(0);
  }

  /** 把 /api/stock 的 fundamentals 与列表里的 fundamental 合成一份好渲染的数据 */
  function normalizeFundamental(api, local) {
    if (api) {
      const p = api.performance || null;
      const v = api.valuation || null;
      const h = api.holder || null;
      const o = api.org || null;
      const fin = api.finance || null;
      const pick = (...vals) => vals.find((x) => Number.isFinite(x)) ?? null;
      return {
        reportPeriod: (p && p.reportDate) || api.reportDate || (local && local.reportPeriod) || '',
        industry: (v && v.industry) || (local && local.industry) || '',
        roe: pick(p && p.roe, fin && fin.roe),
        revenue: pick(p && p.revenue),
        netProfit: pick(p && p.netProfit),
        revenueYoy: pick(p && p.revenueYoy),
        profitYoy: pick(p && p.profitYoy),
        grossMargin: pick(p && p.grossMargin, fin && fin.grossMargin),
        eps: pick(p && p.eps),
        bps: pick(p && p.bps),
        ocfPerShare: pick(p && p.ocfPerShare),
        debtRatio: pick(fin && fin.debtRatio, local && local.debtRatio),
        currentRatio: pick(fin && fin.currentRatio, local && local.currentRatio),
        roic: pick(fin && fin.roic, local && local.roic),
        pe: pick(v && v.pe),
        pb: pick(v && v.pb),
        peg: pick(v && v.peg),
        pePct: local ? local.pePct : null,
        pbPct: local ? local.pbPct : null,
        holderNum: pick(h && h.holderNum),
        prevHolderNum: pick(h && h.prevHolderNum),
        holderNumChange: pick(h && h.holderNumChange),
        holderNumRatio: pick(h && h.holderNumRatio),
        avgMarketCap: pick(h && h.avgMarketCap),
        holderEndDate: (h && h.endDate) || (local && local.holderEndDate) || '',
        orgNum: pick(o && o.orgNum),
        orgNumChange: pick(o && o.orgNumChange),
        orgSharesRatio: pick(o && o.orgSharesRatio),
        orgRatioChange: pick(o && o.ratioChange, local && local.orgRatioChange),
        orgLabel: (o && o.label) || (local && local.orgLabel) || '',
        fundCount: api.fundCount ?? null,
        fundRatio: api.fundRatio ?? null,
        fundHolders: api.fundHolders || [],
        holderHistory: api.holderHistory || [],
        orgTypes: api.orgTypes || [],
        subScores: local ? local.subScores : null,
        financial: local ? !!local.financial : false,
      };
    }
    if (!local) return null;
    return {
      ...local,
      fundCount: null,
      fundRatio: null,
      fundHolders: [],
      holderHistory: [],
      orgTypes: [],
    };
  }

  function renderFundamentalCard(inner, data, item) {
    const f = normalizeFundamental(data && data.fundamentals, item && item.fundamental);
    if (!f) return;

    const card = el('div', 'card');
    const kv = (k, v, cls) => `<div class="kv"><span class="k">${k}</span><span class="${cls || ''}">${v}</span></div>`;
    let html = `<h3>公司基本面 <span class="badge">${
      f.reportPeriod ? `${f.reportPeriod} 财报` : '最新财报'
    }</span>${f.industry ? `<span class="badge">${f.industry}</span>` : ''}${
      f.financial ? '<span class="badge cold">金融股口径</span>' : ''
    }</h3>`;

    html += '<div class="kv-grid">';
    html += kv('营业收入', f.revenue !== null ? yi(f.revenue) : '-');
    html += kv('营收同比', pctText(f.revenueYoy), pctClass(f.revenueYoy));
    html += kv('净利润', f.netProfit !== null ? yi(f.netProfit) : '-');
    html += kv('净利同比', pctText(f.profitYoy), pctClass(f.profitYoy));
    html += kv('加权 ROE', f.roe !== null ? `${num(f.roe)}%` : '-');
    html += kv('毛利率', f.grossMargin !== null ? `${num(f.grossMargin)}%` : '-');
    html += kv('每股收益', f.eps !== null ? num(f.eps) : '-');
    html += kv('每股净资产', f.bps !== null ? num(f.bps) : '-');
    html += kv('每股经营现金流', f.ocfPerShare !== null ? num(f.ocfPerShare) : '-');
    html += kv('资产负债率', f.debtRatio !== null ? `${num(f.debtRatio)}%` : '-');
    html += kv('流动比率', f.currentRatio !== null ? num(f.currentRatio) : '-');
    html += kv('ROIC', f.roic !== null ? `${num(f.roic)}%` : '-');
    html += '</div>';

    html += '<h3 style="margin-top:14px">估值位置</h3><div class="kv-grid">';
    html += kv('PE(TTM)', f.pe !== null && f.pe > 0 ? num(f.pe) : f.pe !== null ? '亏损' : '-');
    html += kv('PB', f.pb !== null ? num(f.pb) : '-');
    html += kv('PEG', f.peg !== null ? num(f.peg) : '-');
    html += kv('PE 行业分位', Number.isFinite(f.pePct) ? `${Math.round(f.pePct * 100)}%（越低越便宜）` : '-');
    html += kv('PB 行业分位', Number.isFinite(f.pbPct) ? `${Math.round(f.pbPct * 100)}%` : '-');
    html += '</div>';

    html += `<h3 style="margin-top:14px">股东户数 <span class="badge">${
      f.holderEndDate ? `${f.holderEndDate} 期末` : '最新一期'
    }</span></h3><div class="kv-grid">`;
    html += kv('股东户数', wan(f.holderNum));
    html += kv('上期户数', wan(f.prevHolderNum));
    html += kv('户数变化', Number.isFinite(f.holderNumChange) ? `${f.holderNumChange > 0 ? '+' : '-'}${wan(Math.abs(f.holderNumChange))}` : '-');
    html += kv('户数环比', pctText(f.holderNumRatio));
    html += kv('户均持股市值', f.avgMarketCap !== null ? `${yuan(f.avgMarketCap)}元` : '-');
    html += '</div>';
    html += `<div class="ev-impact">${
      Number.isFinite(f.holderNumRatio)
        ? f.holderNumRatio < 0
          ? '户数减少说明筹码在向少数人集中，通常是主力/机构吸筹的特征，对后续上涨有利。'
          : '户数增加说明筹码在分散，散户接盘的成分更多，需要更谨慎。'
        : '暂无股东户数数据。'
    }</div>`;

    html += `<h3 style="margin-top:14px">机构与基金持股</h3><div class="kv-grid">`;
    html += kv('机构家数', Number.isFinite(f.orgNum) ? `${f.orgNum} 家` : '-');
    html += kv('家数变化', Number.isFinite(f.orgNumChange) ? `${f.orgNumChange > 0 ? '+' : ''}${f.orgNumChange} 家` : '-');
    html += kv('机构持股占流通股', Number.isFinite(f.orgSharesRatio) ? `${num(f.orgSharesRatio)}%` : '-');
    html += kv('持股总量环比', pctText(f.orgRatioChange), pctClass(f.orgRatioChange));
    html += kv('机构标签', f.orgLabel || '-');
    html += kv('基金持股家数', Number.isFinite(f.fundCount) ? `${f.fundCount} 家` : '-');
    html += '</div>';
    html += '<div class="ev-impact">机构家数受披露口径影响（中报/年报披露全部基金，家数天然更多），' +
      '看"持股数量与占流通股比例的变化"更可靠。</div>';

    if (f.orgTypes && f.orgTypes.length) {
      html += `<div class="kv-grid" style="margin-top:10px">${f.orgTypes
        .filter((t) => t.type !== '00')
        .map((t) => kv(`${t.typeName}家数`, Number.isFinite(t.orgCount) ? `${t.orgCount} 家` : '-'))
        .join('')}</div>`;
    }

    if (f.fundHolders && f.fundHolders.length) {
      html += '<h3 style="margin-top:14px">基金持仓明细（前 10）</h3>';
      html += f.fundHolders
        .map(
          (h) => `<div class="evi">
            <div class="t">${h.name}${h.fundCompany ? ` <span class="stock-code">${h.fundCompany}</span>` : ''}</div>
            <div class="m">持股 ${Number.isFinite(h.shares) ? wan(h.shares) : '-'} 股 · 持股市值 ${
              Number.isFinite(h.marketCap) ? yi(h.marketCap) : '-'
            } · 占流通股 ${Number.isFinite(h.sharesRatio) ? `${num(h.sharesRatio)}%` : '-'}</div>
          </div>`,
        )
        .join('');
    }

    if (f.holderHistory && f.holderHistory.length > 1) {
      html += '<h3 style="margin-top:14px">股东户数历史</h3><div class="kv-grid">';
      html += f.holderHistory
        .slice(0, 6)
        .map((r) => kv(r.endDate || '-', `${wan(r.holderNum)} / ${pctText(r.holderNumRatio)}`))
        .join('');
      html += '</div>';
    }

    if (f.subScores) {
      const s = f.subScores;
      html += '<h3 style="margin-top:14px">基本面五维评分</h3><div class="kv-grid">';
      html += kv('成长', s.growth);
      html += kv('质量', s.quality);
      html += kv('估值', s.value);
      html += kv('筹码', s.chips);
      html += kv('机构', s.institution);
      html += kv('基本面总分', item && item.fundScore !== null && item.fundScore !== undefined ? item.fundScore : '-');
      html += '</div>';
    }

    card.innerHTML = html;
    inner.appendChild(card);
  }

  /* ---------------------- 数据加载 ---------------------- */

  async function loadOverview() {
    try {
      state.overview = await api('/api/overview');
      renderMarketStrip();
    } catch (err) {
      setStatus(`行情异常：${err.message}`);
    }
  }

  async function loadPicks(force) {
    if (state.loadingPicks) return;
    state.loadingPicks = true;
    const started = Date.now();
    const timer = setInterval(() => {
      setStatus(`计算中 ${Math.round((Date.now() - started) / 1000)}s`);
    }, 1000);
    $('#refreshBtn').disabled = true;
    try {
      state.picks = await api(`/api/picks${force ? '?force=1' : ''}`);
      state.detailCache.clear();
      const errs = ['sentiment', 'news', 'event', 'fundamental']
        .map((k) => (state.picks[k] && state.picks[k].error ? `${k}:${state.picks[k].error}` : null))
        .filter(Boolean);
      setStatus(
        `完成 ${Math.round(state.picks.elapsedMs / 1000)}s` + (errs.length ? `（部分失败 ${errs.join(',')}）` : ''),
      );
      render();
    } catch (err) {
      setStatus(`计算失败：${err.message}`);
      toast(`选股失败：${err.message}`);
      render();
    } finally {
      clearInterval(timer);
      state.loadingPicks = false;
      $('#refreshBtn').disabled = false;
    }
  }

  async function loadEvents() {
    if (state.events) return;
    try {
      state.events = await api('/api/events');
      if (state.tab === 'calendar') render();
    } catch (err) {
      toast(`事件日历加载失败：${err.message}`);
    }
  }

  /* ---------------------- 事件绑定与启动 ---------------------- */

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
    closeDetail();
    render();
    if (state.tab === 'calendar') loadEvents();
    if (state.tab === 'portfolio') loadPortfolio(false);
  });

  $('#refreshBtn').addEventListener('click', () => {
    state.detailCache.clear();
    loadOverview();
    loadPicks(true);
  });

  $('#scrim').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDetail();
  });
  window.addEventListener('resize', () => {
    if (!state.detailCode) return;
    const tc = document.querySelector('#trendCanvas');
    const kc = document.querySelector('#kCanvas');
    const data = state.detailCache.get(state.detailCode);
    if (!data) return;
    if (tc) window.Charts.drawTrends(tc, data.trends);
    if (kc) window.Charts.drawKline(kc, data.kline && data.kline.bars);
  });

  window.addEventListener('resize', () => {
    if (state.tab !== 'portfolio' || !state.portfolio) return;
    const c = document.getElementById('equityCanvas');
    if (c) window.Charts.drawEquity(c, state.portfolio.equity || [], state.portfolio.profile.initialCapital);
  });

  /* ---------------------- 手动检查更新 ---------------------- */

  const updateApi = window.chaogu && window.chaogu.updates ? window.chaogu.updates : null;
  const updateModel = { status: {} };

  function updateText(s) {
    switch (s.status) {
      case 'checking': return '正在检查…';
      case 'available': return '发现新版本';
      case 'not-available': return '已是最新';
      case 'downloading': return '下载中 ' + (s.progress || 0) + '%';
      case 'downloaded': return '正在安装';
      case 'error': return '检查失败';
      default: return '待检查';
    }
  }

  function updateHtml() {
    const s = updateModel.status || {};
    const cls = s.status === 'available'
      ? 'up-badge up-badge-new'
      : (s.status === 'error' ? 'up-badge up-badge-err' : 'up-badge');

    const rows = [];
    rows.push('<div class="up-row"><span>当前版本</span><b>v' + esc(s.current || '—') + '</b></div>');
    rows.push('<div class="up-row"><span>最新版本</span><b>' + (s.latest ? 'v' + esc(s.latest) : '—') + '</b></div>');
    rows.push('<div class="up-row"><span>状态</span><span class="' + cls + '">' + esc(updateText(s)) + '</span></div>');

    const progress = s.status === 'downloading'
      ? '<div class="up-progress"><i style="width:' + Math.max(2, Math.min(100, s.progress || 0)) + '%"></i></div>'
      : '';
    const notes = s.notes && s.status === 'available'
      ? '<div class="up-notes">' + esc(s.notes) + '</div>'
      : '';
    let hint = '';
    if (s.error) hint = '<div class="up-hint">' + esc(s.message || '') + '：' + esc(s.error) + '</div>';
    else if (s.message && s.status !== 'available') hint = '<div class="up-hint">' + esc(s.message) + '</div>';

    const actions = [];
    if (!updateApi) {
      actions.push('<button class="btn ghost" data-act="close">关闭</button>');
    } else {
      if (s.status === 'available' || s.status === 'error' || s.status === 'downloaded') {
        actions.push('<button class="btn" data-act="install">下载并安装</button>');
      }
      if (s.status !== 'downloading' && s.status !== 'downloaded') {
        actions.push('<button class="btn ghost" data-act="check">重新检查</button>');
      }
      if (s.error) actions.push('<button class="btn ghost" data-act="page">去下载页</button>');
      actions.push('<button class="btn ghost" data-act="close">关闭</button>');
    }

    return rows.join('') + progress + notes + hint + '<div class="up-actions">' + actions.join('') + '</div>';
  }

  function renderUpdate() {
    const body = $('#updateBody');
    if (body) body.innerHTML = updateHtml();
  }

  function closeUpdatePanel() {
    const overlay = $('#updateOverlay');
    if (overlay) overlay.hidden = true;
  }

  async function openUpdatePanel(runCheck) {
    const overlay = $('#updateOverlay');
    if (!overlay) return;
    overlay.hidden = false;
    renderUpdate();
    if (runCheck && updateApi) {
      updateModel.status = await updateApi.check();
      renderUpdate();
    }
  }

  function initUpdate() {
    const btn = $('#updateBtn');
    const overlay = $('#updateOverlay');
    const body = $('#updateBody');
    if (!btn || !overlay || !body) return;

    if (updateApi) {
      updateApi.onStatus((s) => { updateModel.status = s; renderUpdate(); });
      updateApi.getState().then((s) => { updateModel.status = s; }).catch(() => {});
    } else {
      updateModel.status = { message: '浏览器外壳模式不能自动更新，请用安装版桌面应用。' };
    }

    btn.addEventListener('click', () => { openUpdatePanel(true).catch(() => {}); });
    $('#updateCloseBtn').addEventListener('click', closeUpdatePanel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeUpdatePanel(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeUpdatePanel(); });

    body.addEventListener('click', async (e) => {
      const act = e.target && e.target.dataset ? e.target.dataset.act : '';
      if (!act) return;
      if (act === 'close') { closeUpdatePanel(); return; }
      if (act === 'page') { if (updateApi) updateApi.openReleasePage(); return; }
      if (!updateApi) return;

      e.target.disabled = true;
      try {
        if (act === 'check') updateModel.status = await updateApi.check();
        else if (act === 'install') updateModel.status = await updateApi.downloadAndInstall();
      } catch (err) {
        toast(err && err.message ? err.message : '操作失败');
      } finally {
        if (e.target) e.target.disabled = false;
        renderUpdate();
      }
    });
  }

  initUpdate();
  initSearch();
  initHoldingMonitor();

  $('#alertCloseBtn').addEventListener('click', () => { $('#alertOverlay').hidden = true; });
  $('#alertOverlay').addEventListener('click', (e) => {
    if (e.target === $('#alertOverlay')) $('#alertOverlay').hidden = true;
  });

  setStatus('准备中');
  loadOverview();
  loadPicks(false);
  setInterval(loadOverview, 30 * 1000);
  setInterval(() => {
    if (state.tab !== 'calendar' && state.tab !== 'portfolio') loadPicks(false);
  }, 180 * 1000);
  setInterval(() => {
    if (state.tab === 'portfolio') loadPortfolio(false);
  }, 90 * 1000);
})();
