/**
 * 抢场页内自旋代理（由 Dart 注入；占位符 __XXX__ 在注入前替换）
 *
 * 目标：把「等开抢 → 选中若干目标格 → 拿到下一步按钮坐标」整段压进页面内部，
 *      关键路径上不再有任何 Dart↔JS 往返（原来每轮 2 次 RPC，约 40~80ms）。
 *
 * 注入前替换的三个占位符：
 *   TARGETS  —— [[timeIndex, courtIndex], ...] 目标格列表（0 基，与 Dart 侧一致）
 *   HANDLER  —— callHandler 名称
 *   DEADLINE —— 整体超时（毫秒）
 *
 * 设计约束（见 CLAUDE.md 5.1）：
 * - 只做页面内的选择和测量；「下一步」「接受」两处仍由 Dart 用原生触控完成（站点校验 isTrusted）。
 * - 每个目标格只点一次：点过但页面没给出 selected 时不再重复点（重复点可能被当成取消选中）。
 * - 不伪造 isTrusted，不直接调组件方法。
 */
(function () {
  var TARGETS = __TARGETS__;
  var HANDLER = '__HANDLER__';
  var DEADLINE = __DEADLINE_MS__;

  if (window.__grab && window.__grab.stop) { try { window.__grab.stop(); } catch (e) {} }

  function bodyTable() {
    return document.querySelector('.schedule__body-wrapper table')
        || document.querySelector('.schedule-table__body-wrapper table')
        || document.querySelector('.schedule-table table');
  }
  function rows(table) {
    var out = [], trs = table.querySelectorAll('tbody tr');
    for (var i = 0; i < trs.length; i++) {
      if (trs[i].classList && trs[i].classList.contains('alignmentRow')) continue;
      out.push(trs[i]);
    }
    return out;
  }
  function courtIds() {
    var ids = [], ht = document.querySelector('.schedule-table__header-wrapper table');
    if (ht) {
      var ths = ht.querySelectorAll('thead tr:last-child th[data-platform-id]');
      for (var i = 0; i < ths.length; i++) {
        var id = ths[i].getAttribute('data-platform-id');
        if (id && id !== '-1') ids.push(id);
      }
    }
    return ids;
  }
  function has(el, name) {
    return (' ' + (el.className || '') + ' ').indexOf(' ' + name + ' ') !== -1;
  }
  // 按「行号 + 表头场地 id」定位；被上方 rowspan 覆盖时按纵向几何回捞
  function findCell(timeIndex, courtIndex) {
    var table = bodyTable();
    if (!table) return { err: 'NO_BODY_TABLE' };
    var rs = rows(table), ids = courtIds(), td = null;
    if (timeIndex < 0 || timeIndex >= rs.length) {
      return { err: 'ROW_OUT_OF_RANGE', rowCount: rs.length };
    }
    var row = rs[timeIndex];
    if (ids.length) {
      if (courtIndex < 0 || courtIndex >= ids.length) {
        return { err: 'COL_OUT_OF_RANGE', courtCount: ids.length };
      }
      var cid = ids[courtIndex];
      var same = row.querySelectorAll('td[data-platform-id]');
      for (var i = 0; i < same.length; i++) {
        if (same[i].getAttribute('data-platform-id') === cid) { td = same[i]; break; }
      }
      if (!td) {
        var rr0 = row.getBoundingClientRect(), cy = rr0.top + rr0.height / 2;
        var all = table.querySelectorAll('td[data-platform-id="' + cid + '"]');
        for (var j = 0; j < all.length; j++) {
          var r2 = all[j].getBoundingClientRect();
          if (cy >= r2.top - 1 && cy <= r2.top + r2.height + 1) { td = all[j]; break; }
        }
      }
    } else {
      var tds = row.querySelectorAll('td');
      if (courtIndex >= 0 && courtIndex < tds.length) td = tds[courtIndex];
    }
    if (!td) return { err: 'CELL_NOT_FOUND' };
    return { td: td, cid: ids[courtIndex] || '' };
  }
  // 与站点 onSelect 的准入条件对齐：未开抢 / 无库存 / 已过期 / 非线上 / 已被占
  function selectable(td) {
    if (has(td, 'selected')) return false;
    if (has(td, 'noOpen') || has(td, 'noBook') || has(td, 'expired') || has(td, 'noOnline')) return false;
    if (!(has(td, 'col-ball') || has(td, 'col-max-ball'))) return false;
    return true;
  }
  function nextButton() {
    var nodes = document.querySelectorAll('button.el-button, button, .van-button');
    for (var i = 0; i < nodes.length; i++) {
      var t = ((nodes[i].innerText || '').replace(/\s+/g, ' ')).trim();
      if (t !== '下一步') continue;
      if (nodes[i].disabled || has(nodes[i], 'is-disabled')) continue;
      var r = nodes[i].getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      return nodes[i];
    }
    return null;
  }
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  function report(obj) {
    var json = JSON.stringify(obj);
    window.__grabState = json;
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler(HANDLER, json);
      }
    } catch (e) {}
  }
  // 用同源请求的 Date 响应头估服务器时间（不碰业务接口，只读时标）
  function probeClock(cb) {
    var t0 = Date.now();
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('HEAD', '/pub/basic/isLogin', true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        try {
          var d = xhr.getResponseHeader('Date');
          if (d) {
            var rtt = Date.now() - t0;
            cb(Math.round(new Date(d).getTime() + rtt / 2 - Date.now()));
            return;
          }
        } catch (e) {}
        cb(null);
      };
      xhr.send(null);
    } catch (e) { cb(null); }
  }

  var state = {
    phase: 'init', frames: 0, tries: 0, startedAt: Date.now(), offsetMs: null,
    targets: TARGETS.map(function (t) {
      return { time: t[0], court: t[1], clicked: false, done: false };
    }),
  };
  var stopped = false, won = false, raf = null;

  function tick() {
    if (stopped || won) return;
    state.frames++;
    if (Date.now() - state.startedAt > DEADLINE) {
      report({
        ok: false, err: 'TIMEOUT', frames: state.frames, tries: state.tries,
        targets: state.targets.map(function (t) {
          return t.time + '/' + t.court + (t.done ? ':selected' : (t.clicked ? ':clicked' : ':wait'));
        }),
      });
      return;
    }
    var needWait = false;
    for (var i = 0; i < state.targets.length; i++) {
      var tg = state.targets[i];
      if (tg.done) continue;
      var found = findCell(tg.time, tg.court);
      if (found.err) {
        state.phase = found.err;
        report({
          ok: false, err: found.err, rowCount: found.rowCount, courtCount: found.courtCount,
          target: tg.time + '/' + tg.court,
        });
        return;
      }
      var td = found.td;
      tg.cid = found.cid;                      // 记录场地 id，供上报使用
      if (has(td, 'selected')) { tg.done = true; continue; }
      if (!selectable(td)) { needWait = true; continue; }   // 未开抢 / 不可订
      if (tg.clicked) { needWait = true; continue; }        // 点过但还没 selected：等，绝不重复点
      tg.clicked = true;
      state.tries++;
      td.click();
      needWait = true;
    }
    if (needWait) {
      state.phase = 'wait';
      raf = requestAnimationFrame(tick);
      return;
    }
    var btn = nextButton();
    if (!btn) { state.phase = 'wait-button'; raf = requestAnimationFrame(tick); return; }
    won = true;
    state.phase = 'done';
    report({
      ok: true,
      venueIds: state.targets.map(function (t) { return t.cid || ''; }),
      frames: state.frames,
      tries: state.tries,
      sinceStartMs: Date.now() - state.startedAt,
      offsetMs: state.offsetMs,
      btn: rectOf(btn),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    });
  }

  probeClock(function (off) { state.offsetMs = off; });
  raf = requestAnimationFrame(tick);

  window.__grab = {
    stop: function () { stopped = true; if (raf) cancelAnimationFrame(raf); },
    state: state,
  };
})();
