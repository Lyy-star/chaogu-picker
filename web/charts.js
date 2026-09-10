/* 极简 Canvas 图表：分时线 + 日线K线。无第三方依赖。 */
(function () {
  'use strict';

  const COLORS = {
    bg: '#151922',
    grid: '#232a36',
    axis: '#5f6779',
    text: '#8b93a5',
    up: '#f0453a',
    down: '#21b573',
    line: '#4f8cff',
    avg: '#f0a33a',
    ma5: '#ffffff',
    ma10: '#f0c53a',
    ma20: '#c07bf0',
  };

  function setup(canvas, height) {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function fmt(v, digits = 2) {
    if (!Number.isFinite(v)) return '-';
    return v.toFixed(digits);
  }

  function grid(ctx, box, rows) {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= rows; i += 1) {
      const y = box.y + (box.h / rows) * i;
      ctx.beginPath();
      ctx.moveTo(box.x, y);
      ctx.lineTo(box.x + box.w, y);
      ctx.stroke();
    }
  }

  function text(ctx, str, x, y, align = 'left', color = COLORS.text) {
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.font = '11px "Microsoft YaHei", system-ui, sans-serif';
    ctx.fillText(str, x, y);
  }

  /* --------------------------- 分时图 --------------------------- */
  function drawTrends(canvas, trends) {
    const H = 200;
    const { ctx, width, height } = setup(canvas, H);
    const points = (trends && trends.points) || [];
    if (!points.length) {
      text(ctx, '暂无分时数据', width / 2, H / 2, 'center');
      return;
    }

    const preClose = trends.preClose;
    const prices = points.map((p) => p.price).filter(Number.isFinite);
    const avg = points.map((p) => p.avg).filter(Number.isFinite);
    let hi = Math.max(...prices, ...avg, preClose || 0);
    let lo = Math.min(...prices, ...avg, preClose || Infinity);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) return;
    // 上下各留 12% 空间，围绕昨收做对称，符合分时图习惯
    const span = Math.max(hi - preClose, preClose - lo, preClose * 0.005) * 1.15;
    hi = preClose + span;
    lo = preClose - span;

    const padL = 52;
    const padR = 46;
    const volH = 40;
    const gap = 8;
    const box = { x: padL, y: 10, w: width - padL - padR, h: H - 20 - volH - gap };
    const volBox = { x: padL, y: box.y + box.h + gap, w: box.w, h: volH };

    const px = (i) => box.x + (box.w * i) / Math.max(points.length - 1, 1);
    const py = (v) => box.y + box.h - ((v - lo) / (hi - lo)) * box.h;

    grid(ctx, box, 4);
    grid(ctx, volBox, 1);

    // 昨收基准线
    const yClose = py(preClose);
    ctx.strokeStyle = '#3b4453';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(box.x, yClose);
    ctx.lineTo(box.x + box.w, yClose);
    ctx.stroke();
    ctx.setLineDash([]);

    // 价格线
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    points.forEach((p, i) => {
      if (!Number.isFinite(p.price)) return;
      const x = px(i);
      const y = py(p.price);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 均价线
    ctx.strokeStyle = COLORS.avg;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    let started = false;
    points.forEach((p, i) => {
      if (!Number.isFinite(p.avg)) return;
      const x = px(i);
      const y = py(p.avg);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 成交量
    const vols = points.map((p) => p.volume || 0);
    const maxVol = Math.max(...vols, 1);
    points.forEach((p, i) => {
      const v = p.volume || 0;
      const h = (v / maxVol) * volBox.h;
      ctx.fillStyle = p.price >= (points[i - 1] ? points[i - 1].price : preClose) ? 'rgba(240,69,58,.5)' : 'rgba(33,181,115,.5)';
      ctx.fillRect(px(i) - 1, volBox.y + volBox.h - h, 2, h);
    });

    // 坐标文字
    text(ctx, fmt(hi), padL - 6, box.y, 'right');
    text(ctx, fmt(preClose), padL - 6, yClose, 'right', COLORS.avg);
    text(ctx, fmt(lo), padL - 6, box.y + box.h, 'right');
    const first = points[0] && points[0].time;
    const last = points[points.length - 1] && points[points.length - 1].time;
    if (first) text(ctx, first, box.x, box.y + box.h + 6, 'left');
    if (last) text(ctx, last, box.x + box.w, box.y + box.h + 6, 'right');

    const lastPrice = points[points.length - 1].price;
    const pct = preClose ? ((lastPrice - preClose) / preClose) * 100 : 0;
    text(ctx, fmt(lastPrice), width - padR + 8, yClose, 'left', pct >= 0 ? COLORS.up : COLORS.down);
  }

  /* --------------------------- 日线图 --------------------------- */
  function ma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function drawKline(canvas, bars, limit = 90) {
    const H = 280;
    const { ctx, width } = setup(canvas, H);
    const data = (bars || []).slice(-limit);
    if (!data.length) {
      text(ctx, '暂无日线数据', width / 2, H / 2, 'center');
      return;
    }

    const closes = data.map((b) => b.close);
    const mas = { ma5: ma(closes, 5), ma10: ma(closes, 10), ma20: ma(closes, 20) };
    const highs = data.map((b) => b.high);
    const lows = data.map((b) => b.low);
    let hi = Math.max(...highs);
    let lo = Math.min(...lows);
    const pad = (hi - lo) * 0.08 || hi * 0.02;
    hi += pad;
    lo -= pad;

    const padL = 54;
    const padR = 46;
    const volH = 46;
    const gap = 8;
    const box = { x: padL, y: 10, w: width - padL - padR, h: H - 20 - volH - gap };
    const volBox = { x: padL, y: box.y + box.h + gap, w: box.w, h: volH };

    const step = box.w / data.length;
    const cw = Math.max(2, Math.min(9, step * 0.62));
    const py = (v) => box.y + box.h - ((v - lo) / (hi - lo)) * box.h;

    grid(ctx, box, 4);
    grid(ctx, volBox, 1);

    const maxVol = Math.max(...data.map((b) => b.volume || 0), 1);

    data.forEach((b, i) => {
      const cx = box.x + step * i + step / 2;
      const isUp = b.close >= b.open;
      const color = isUp ? COLORS.up : COLORS.down;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, py(b.high));
      ctx.lineTo(cx, py(b.low));
      ctx.stroke();
      const yo = py(b.open);
      const yc = py(b.close);
      const top = Math.min(yo, yc);
      const h = Math.max(Math.abs(yc - yo), 1);
      if (isUp) {
        ctx.fillRect(cx - cw / 2, top, cw, h);
      } else {
        ctx.fillRect(cx - cw / 2, top, cw, h);
      }

      const vh = ((b.volume || 0) / maxVol) * volBox.h;
      ctx.fillStyle = isUp ? 'rgba(240,69,58,.55)' : 'rgba(33,181,115,.55)';
      ctx.fillRect(cx - cw / 2, volBox.y + volBox.h - vh, cw, vh);
    });

    Object.entries(mas).forEach(([key, series]) => {
      ctx.strokeStyle = COLORS[key];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      series.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = box.x + step * i + step / 2;
        const y = py(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    text(ctx, fmt(hi), padL - 6, box.y, 'right');
    text(ctx, fmt((hi + lo) / 2), padL - 6, box.y + box.h / 2, 'right');
    text(ctx, fmt(lo), padL - 6, box.y + box.h, 'right');
    text(ctx, data[0].date, box.x, box.y + box.h + 6, 'left');
    text(ctx, data[data.length - 1].date, box.x + box.w, box.y + box.h + 6, 'right');
  }

  /* --------------------------- 净值曲线 --------------------------- */
  /**
   * 模拟盘净值曲线：以 10 万本金为基准线，画总资产走势。
   * equity: [{ date, nav, totalAssets }]
   */
  function drawEquity(canvas, equity, initialCapital) {
    const H = 230;
    const { ctx, width } = setup(canvas, H);
    const data = (equity || []).filter((e) => Number.isFinite(e.totalAssets));
    if (!data.length) {
      text(ctx, '还没有记录，打开应用就会生成第一天的记录', width / 2, H / 2, 'center');
      return;
    }

    const base = Number.isFinite(initialCapital) && initialCapital > 0 ? initialCapital : data[0].totalAssets;
    const values = data.map((e) => e.totalAssets);
    let hi = Math.max(...values, base);
    let lo = Math.min(...values, base);
    const pad = Math.max((hi - lo) * 0.2, base * 0.005);
    hi += pad;
    lo -= pad;

    const padL = 68;
    const padR = 74;
    const box = { x: padL, y: 16, w: Math.max(width - padL - padR, 40), h: H - 52 };
    const step = data.length > 1 ? box.w / (data.length - 1) : 0;
    const px = (i) => box.x + (data.length > 1 ? step * i : box.w / 2);
    const py = (v) => box.y + box.h - ((v - lo) / (hi - lo)) * box.h;

    grid(ctx, box, 4);

    // 本金基准线
    const yBase = py(base);
    ctx.strokeStyle = '#3b4453';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(box.x, yBase);
    ctx.lineTo(box.x + box.w, yBase);
    ctx.stroke();
    ctx.setLineDash([]);

    // 面积
    const grad = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
    grad.addColorStop(0, 'rgba(79,140,255,.28)');
    grad.addColorStop(1, 'rgba(79,140,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(px(0), yBase);
    data.forEach((e, i) => ctx.lineTo(px(i), py(e.totalAssets)));
    ctx.lineTo(px(data.length - 1), yBase);
    ctx.closePath();
    ctx.fill();

    // 净值线
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    data.forEach((e, i) => {
      const x = px(i);
      const y = py(e.totalAssets);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 末点标注
    const last = data[data.length - 1];
    const lastUp = last.totalAssets >= base;
    const ly = py(last.totalAssets);
    ctx.fillStyle = lastUp ? COLORS.up : COLORS.down;
    ctx.beginPath();
    ctx.arc(px(data.length - 1), ly, 3, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, fmt(last.totalAssets, 0), width - padR + 10, ly, 'left', lastUp ? COLORS.up : COLORS.down);

    text(ctx, fmt(hi, 0), padL - 8, box.y, 'right');
    text(ctx, `本金 ${fmt(base, 0)}`, padL - 8, yBase, 'right', COLORS.avg);
    text(ctx, fmt(lo, 0), padL - 8, box.y + box.h, 'right');
    text(ctx, data[0].date, box.x, box.y + box.h + 14, 'left');
    if (data.length > 1) text(ctx, last.date, box.x + box.w, box.y + box.h + 14, 'right');
  }

  window.Charts = { drawTrends, drawKline, drawEquity };
})();
