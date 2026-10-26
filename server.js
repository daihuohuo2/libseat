#!/usr/bin/env node
/**
 * 中南大学图书馆座位预约助手
 * ------------------------------------------------------------
 * 后端服务 + 抢座核心。零第三方依赖（只用 Node 内置模块）。
 *
 * 启动：node server.js   （或双击 启动.bat）
 * 界面：浏览器打开 http://127.0.0.1:8848
 * ------------------------------------------------------------
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const browserLogin = require('./browser-login.js');
const seatPrefs = require('./seat-prefs.js');
const areaSeatPrefs = require('./public/area-seat-prefs.js');
const { BookingStore, bookingEnded } = require('./booking-store.js');
const { validateBookingWindow } = require('./booking-window.js');
const { selectedAreaIds, resolveBookingRule, resolveRenewalRule, validateSubmission, orderBody } = require('./booking-protocol.js');
const { currentRecordsSource, recordsEndpoint, matchesRecord } = require('./reservation-records.js');
const { Renewal } = require('./renewal.js');
const { BookingManagement, describe, findBooking } = require('./booking-management.js');
const { SeatWatch } = require('./seat-watch.js');

const BASE = 'https://libzw.csu.edu.cn';
const AES_IV = 'ZZWBKJ_ZHIHUAWEI';
const PORT = Number(process.env.PORT) || 8848;
const ROOT = __dirname;
const CONFIG_FILE = process.env.LIBSEAT_CONFIG_FILE || path.join(ROOT, 'config.json');
const LOG_FILE = process.env.LIBSEAT_LOG_FILE || path.join(ROOT, 'libseat.log');
const bookingStore = new BookingStore(process.env.LIBSEAT_BOOKINGS_FILE || path.join(path.dirname(CONFIG_FILE), 'bookings.json'));

/* ============================================================
 * 一、AES 加密（与前端 AY() 函数完全一致）
 *    key = YYYYMMDD + reverse(YYYYMMDD)   例如 20260926 -> 2026092662906202
 *    iv  = 'ZZWBKJ_ZHIHUAWEI'  (固定)
 *    算法 = AES-128-CBC / Pkcs7，输出 Base64
 * ============================================================ */
function aesKey(date) {
  const d = date || new Date();
  const s = '' + d.getFullYear()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
  return s + s.split('').reverse().join('');
}

function aesEncrypt(obj) {
  const c = crypto.createCipheriv('aes-128-cbc',
    Buffer.from(aesKey(), 'utf8'), Buffer.from(AES_IV, 'utf8'));
  return c.update(JSON.stringify(obj), 'utf8', 'base64') + c.final('base64');
}

function aesDecrypt(b64) {
  const d = crypto.createDecipheriv('aes-128-cbc',
    Buffer.from(aesKey(), 'utf8'), Buffer.from(AES_IV, 'utf8'));
  return d.update(b64, 'base64', 'utf8') + d.final('utf8');
}

/* ============================================================
 * 二、配置读写
 * ============================================================ */
const DEFAULT_CONFIG = {
  token: '',
  premisesIds: ['1'],          // 潇湘校区馆
  storeyIds: ['5'],            // 五楼
  areaIds: ['59', '57'],       // A区 / B区
  areaNames: { '59': '五楼A区', '57': '五楼B区' },
  dateMode: 'today',           // today = 当日, tomorrow = 次日
  timeMode: 'now',             // now = 实时（自动取当前时段，官网口径）, custom = 固定时段
  axisStart: '08:00',          // 时间轴起点（官网 seat_axis_start）
  axisEnd: '22:00',            // 时间轴终点（官网 seat_axis_end）
  axisStep: 15,                // 取整粒度，分钟（官网 seat_axis_step）
  axisMaxMin: 240,             // 单次最长预约分钟数（官网 seat_axis_max）
  startTime: '08:00',
  endTime: '12:00',
  interval: 6,                 // 轮询间隔（秒）
  maxAttempts: 0,              // 0 = 无限
  usePoints: false,            // 是否提交定位
  lat: '',
  lng: '',
  verifyOnly: true,            // true = 只观察不预约（安全模式）
  autoRefresh: true,           // token 过期时自动静默续期
  seatPrefs: [],               // 心仪座位号，按优先级；为空则任意座位
  seatPrefMode: 'only',        // only = 只抢心仪座位（没有就继续等）；prefer = 优先心仪座位（没有就任意）
  preferAreas: [],             // 抢选区域集合，无优先级；为空则所有目标区
  areaSeatPrefs: {},           // 按区域保存 { mode: 'any' | 'prefer', seats: [] }，优先后本区兜底
  seatPlans: [],               // 心仪座位方案库：[{ id, name, seats: [], mode, areas: [] }]
  activePlanId: ''             // 当前启用的方案 id
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return Object.assign({}, DEFAULT_CONFIG, raw);
    }
  } catch (e) { /* 配置损坏则用默认 */ }
  return Object.assign({}, DEFAULT_CONFIG);
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * 由座位坐标算出区域包围盒（百分比），前端据此把楼层平面图裁剪成"区域特写"
 * 官方也是这么做的：底图按楼层共用，靠缩放定位到某个区。
 */
function areaView(list) {
  const rects = list
    .map(s => ({ x: Number(s.point_x), y: Number(s.point_y), w: Number(s.width), h: Number(s.height) }))
    .filter(r => isFinite(r.x) && isFinite(r.y) && r.w > 0 && r.h > 0);
  if (!rects.length) return { x: 0, y: 0, w: 100, h: 100 };

  let minX = 100, minY = 100, maxX = 0, maxY = 0;
  rects.forEach(r => {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  });
  const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const padX = (maxX - minX) * 0.06 + 1.2;
  const padY = (maxY - minY) * 0.06 + 1.2;
  const x = clip(minX - padX, 0, 100);
  const y = clip(minY - padY, 0, 100);
  const x2 = clip(maxX + padX, 0, 100);
  const y2 = clip(maxY + padY, 0, 100);
  return { x: x, y: y, w: Math.max(x2 - x, 1), h: Math.max(y2 - y, 1) };
}

/** 当前本地时间文本（HH:mm:ss），用于界面显示同步时刻 */
function nowText() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** 从 JWT 里解出到期时间（秒），失败返回 null。只用于界面显示剩余时间，不泄露 token */
function tokenExpiry(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(
      part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number(json.exp) || null;
  } catch (e) { return null; }
}

/** 返回给前端的配置（剔除 token，仅给掩码与到期时间） */
function publicConfig(cfg) {
  const safe = Object.assign({}, cfg);
  if (safe.token) {
    safe.tokenMask = safe.token.slice(0, 12) + '...' + safe.token.slice(-8);
    safe.tokenExp = tokenExpiry(safe.token);
  }
  delete safe.token;
  return safe;
}

/* ============================================================
 * 三、HTTP 接口调用
 * ------------------------------------------------------------
 * 全部请求走同一个串行调度器：本机代理/TUN 环境下并发 TLS 连接容易被
 * 重置（实测并发必失败、串行稳定），串行还能顺带避免触发站点限流。
 *   - 双车道：界面请求（high）优先于引擎轮询请求（low），避免抢座循环
 *     把用户点击界面时的加载卡住
 *   - 单次请求 10 秒超时，防止慢请求长期占用队列
 *   - 网络类瞬时故障自动重试 2 次
 * ============================================================ */
const REQ_TIMEOUT_MS = 10000;
const lanes = { high: [], low: [] };
let pumping = false;

function pump() {
  if (pumping) return;
  pumping = true;
  (async () => {
    while (true) {
      const task = lanes.high.shift() || lanes.low.shift();
      if (!task) {
        pumping = false;
        // 收尾时二次检查，避免"退出瞬间新任务入队却没人调度"
        if (lanes.high.length || lanes.low.length) pump();
        return;
      }
      try { task.resolve(await task.fn()); } catch (e) { task.reject(e); }
    }
  })();
}

function schedule(fn, priority) {
  return new Promise((resolve, reject) => {
    const queuedAt = Date.now();
    const task = async () => {
      if (priority === 'high' && Date.now() - queuedAt > 15000) throw Error('请求排队超时，请稍后重试');
      return fn();
    };
    lanes[priority === 'high' ? 'high' : 'low'].push({ fn: task, resolve: resolve, reject: reject });
    pump();
  });
}

const isTransient = e => {
  const c = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.code) || e.message || '';
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket|fetch failed|network|timeout|aborted/i.test(String(c));
};

/**
 * @param {object} opts { priority: 'high' | 'low' } 界面请求用 high
 */
async function api(pathname, body, token, useCrypto, opts) {
  const priority = (opts && opts.priority) || 'low';
  const submitting = ['/v4/space/confirm', '/v4/space/cancel', '/v4/space/leave', '/v4/space/checkout'].includes(pathname);
  return schedule(async () => {
    let lastErr = null;
    const attempts = submitting || priority === 'high' ? 1 : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (opts && opts.beforeSend) opts.beforeSend();
      try {
        const json = await apiOnce(pathname, body, token, useCrypto);
        if (json && json.code === 10001) maybeAutoRefresh(pathname);
        return json;
      } catch (e) {
        lastErr = e;
        if (attempt + 1 < attempts && isTransient(e)) {
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }, priority);
}

/**
 * 任何接口遇到"登录失效"(10001) 都在后台触发一次静默续期，让程序自愈。
 * 节流 60 秒，且登录流程已在跑时跳过，避免请求风暴。
 */
let lastAutoRefreshAt = 0;
function maybeAutoRefresh(reason) {
  const cfg = loadConfig();
  if (cfg.autoRefresh === false) return;
  if (loginState.active) return;
  if (Date.now() - lastAutoRefreshAt < 60000) return;
  lastAutoRefreshAt = Date.now();
  log('接口返回登录失效（' + reason + '），后台自动续期登录态...', 'warn');
  runLoginFlow({ headlessFirst: true, allowHeaded: false }).catch(() => { });
}

async function apiOnce(pathname, body, token, useCrypto) {
  // Android 体验演示通过 LIBSEAT_MOCK 提供本地数据，不发出真实请求。
  if (process.env.LIBSEAT_MOCK) {
    return require(process.env.LIBSEAT_MOCK).respond(pathname, body || {});
  }
  const payload = useCrypto ? { aesjson: aesEncrypt(body || {}) } : (body || {});
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'authorization': 'bearer' + token,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) throw Error('接口 HTTP ' + res.status);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw Error('接口响应无法解析'); }
  return json;
}

/* ============================================================
 * 四、业务接口封装
 * ============================================================ */

/** 查区域列表（含 free_num 空闲数） */
function fetchAreas(cfg, date, priority) {
  const w = effectiveWindow(cfg, 'view');
  return api('/v4/space/pick', {
    premisesIds: [],
    categoryIds: [],
    storeyIds: [], // 查询所有楼层，再按区域 ID 筛选，避免漏掉跨楼层/跨馆的名单
    boutiqueIds: [],
    date: date,
    start_time: w.start,
    end_time: w.end
  }, cfg.token, false, { priority: priority });
}

/** 查某区域座位列表 */
function fetchSeats(cfg, areaId, date, priority, window) {
  const w = window || effectiveWindow(cfg, 'view');
  return api('/v4/Space/seat', {
    id: areaId,
    day: date,
    label_id: '',
    start_time: w.start,
    end_time: w.end,
    begdate: '',
    enddate: ''
  }, cfg.token, false, { priority: priority });
}

/** 查区域地图信息（含楼层底图 web_plane） */
function fetchSpaceMap(cfg, areaId, date, priority) {
  const w = effectiveWindow(cfg, 'view');
  return api('/v4/Space/map', {
    id: areaId, day: date, start_time: w.start, end_time: w.end
  }, cfg.token, false, { priority: priority });
}

/** 当前启用方案的名称（没有方案则返回空串） */
function activePlanName(cfg) {
  const p = (cfg.seatPlans || []).find(x => x && x.id === cfg.activePlanId);
  return p && p.name ? p.name : '';
}

/** 按"心仪座位"优先级排列候选（实现见 seat-prefs.js） */
function orderCandidates(cfg, freeSeats, areaId) {
  return seatPrefs.orderAreaCandidates(cfg, areaId, freeSeats);
}

/** 提交预约（加密） */
function submitOrder(cfg, seatId, date, window, booking) {
  const w = window || effectiveWindow(cfg, 'book');
  const body = orderBody(seatId, date, w);
  if (cfg.usePoints && cfg.lat && cfg.lng) {
    body.points = {
      lat: Number(cfg.lat),
      lng: Number(cfg.lng),
      time: Math.floor(Date.now() / 1000)
    };
  }
  return api('/v4/space/confirm', body, cfg.token, true, { beforeSend() {
    const live = loadConfig();
    let reason = state.stopFlag ? '任务已停止' : '';
    if (!reason && bookingSignature(live) !== bookingSignature(cfg)) reason = '设置已变化，将按最新设置重新查询';
    if (!reason) reason = validateSubmission(live, date, w);
    if (reason) { const e = new Error(reason); e.beforeSubmission = true; throw e; }
    // A current-day segment starts when submitted; record the actual minute.
    if (w.reserveType === '1' && date === fmtDate(new Date())) {
      const now = new Date();
      const start = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
      booking.startTime = start > w.start ? start : w.start;
    }
    booking.bookedAt = new Date().toISOString();
    try { bookingStore.setPending(booking); }
    catch (e) { e.beforeSubmission = true; e.storageFailure = true; throw e; }
    state.pendingBooking = booking;
  } });
}

function bookingSignature(cfg) {
  return JSON.stringify(['dateMode', 'timeMode', 'startTime', 'endTime', 'axisStart', 'axisEnd',
    'axisStep', 'axisMaxMin', 'verifyOnly', 'areaIds', 'preferAreas', 'areaSeatPrefs', 'seatPrefs', 'seatPrefMode'].map(k => cfg[k]));
}

/* ============================================================
 * 五、日期工具
 * ============================================================ */
function fmtDate(d) {
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

function targetDate(cfg) {
  const d = new Date();
  if (cfg.dateMode === 'tomorrow') d.setDate(d.getDate() + 1);
  return fmtDate(d);
}

/**
 * 计算有效时段
 * @param {object} cfg
 * @param {string} purpose
 *   'view'（默认）= 此刻快照：start = 当前时刻（精确到分钟），end = start + 轴粒度
 *                     —— 实测接口返回的就是"现在"每个座位的实时状态（使用中/空闲/临时离开），
 *                        窗口只要不落在过去，结果就是同一份实时快照。
 *   'book'        = 可提交预约的窗口（复刻官网口径）：start = 现在向上取整到 axisStep，
 *                    end = min(start + axisMaxMin, axisEnd)
 * 实时模式下每次调用都重算，保证始终与当前时刻同步。
 */
function effectiveWindow(cfg, purpose) {
  const isBook = purpose === 'book';

  // 固定时段模式：两个用途都用用户填的时间
  if (cfg.timeMode !== 'now') return { start: cfg.startTime, end: cfg.endTime };

  const p2 = n => String(n).padStart(2, '0');
  const toMin = s => {
    const parts = String(s || '00:00').split(':');
    return (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
  };
  const fmt = m => p2(Math.floor(m / 60)) + ':' + p2(m % 60);

  const axisStart = toMin(cfg.axisStart || '08:00');
  const axisEnd = toMin(cfg.axisEnd || '22:00');
  const step = Math.max(1, Number(cfg.axisStep) || 15);
  const maxMin = Math.max(30, Number(cfg.axisMaxMin) || 240);

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();

  let start;
  if (isBook && cfg.dateMode !== 'tomorrow') {
    // 可预约起点：官方要求落在轴粒度上（向上取整）
    if (mins < axisStart) start = axisStart;
    else {
      start = Math.ceil(mins / step) * step;
      if (start >= axisEnd) start = axisEnd;
    }
  } else if (cfg.dateMode === 'tomorrow') {
    start = axisStart;
  } else {
    // 此刻快照：就是现在这一分钟
    start = Math.min(Math.max(mins, axisStart), axisEnd);
  }

  let end = isBook ? Math.min(start + maxMin, axisEnd) : Math.min(start + step, axisEnd);
  if (end <= start) end = Math.min(start + 1, axisEnd);
  if (end <= start) end = start;
  return { start: fmt(start), end: fmt(end) };
}

/** 实时同步模式的窗口说明（给界面/日志用） */
function windowLabel(cfg) {
  if (cfg.timeMode !== 'now') return '固定 ' + cfg.startTime + '-' + cfg.endTime;
  const v = effectiveWindow(cfg, 'view');
  return '此刻 ' + v.start + '（快照）· 实际预约时段以各区域官网规则为准';
}

/**
 * 目标时段是否已经过去（仅"固定时段 + 当日"模式有意义）
 * 实时模式下窗口永远是当前时段，不存在过期问题。
 */
function windowPassed(cfg) {
  if (cfg.timeMode === 'now') return false;
  if (cfg.dateMode === 'tomorrow') return false;
  const parts = String(cfg.endTime || '00:00').split(':');
  const h = Number(parts[0]), m = Number(parts[1]);
  if (isNaN(h)) return false;
  const end = new Date();
  end.setHours(h, isNaN(m) ? 0 : m, 0, 0);
  return Date.now() >= end.getTime();
}

/**
 * 汇总目标区域状态：接口汇总 free_num + 座位明细可约数（双口径）
 * 明细口径 status==1 才是"该时段真正可约"的座位数
 */
async function collectAreaStatus(cfg, date, priority) {
  const r = await fetchAreas(cfg, date, priority);
  if (r.code !== 0) return { code: r.code, message: r.message };

  const list = (r.data && r.data.area) || [];
  const targetIds = new Set([...(cfg.areaIds || []).map(String), ...selectedAreaIds(cfg)]);
  const targets = list.filter(a => targetIds.has(String(a.id)));
  const areas = [];

  for (const a of targets) {
    let seatFree = null;
    let seatDist = null;
    try {
      const sr = await fetchSeats(cfg, a.id, date, priority);
      if (sr.code === 0) {
        const seats = (sr.data && sr.data.list) || [];
        seatDist = {};
        seats.forEach(s => {
          const k = s.status_name || ('status' + s.status);
          seatDist[k] = (seatDist[k] || 0) + 1;
        });
        seatFree = seats.filter(s => String(s.status) === '1').length;
      }
    } catch (e) { /* 明细拉取失败不影响汇总 */ }

    areas.push({
      id: a.id,
      name: a.nameMerge || a.name,
      free: Number(a.free_num),
      total: Number(a.total_num),
      seatFree: seatFree,
      seatDist: seatDist
    });
  }

  return {
    code: 0, date: date, areas: areas,
    stale: windowPassed(cfg),
    window: effectiveWindow(cfg, 'view'),
    bookWindow: effectiveWindow(cfg, 'book'),
    label: windowLabel(cfg),
    mode: cfg.timeMode === 'now' ? 'now' : 'custom',
    syncedAt: nowText()
  };
}

/* ============================================================
 * 六、抢座引擎
 * ============================================================ */
const state = {
  running: false,
  stopFlag: false,
  logs: [],
  lastCheck: null,
  lastAreas: [],
  orderResult: null,
  lastFailure: '',
  areaCursor: 0,
  booking: null,
  pendingBooking: bookingStore.data.pending,
  checkingBooking: false,
  bookingMessage: bookingStore.data.pending ? '有一笔预约结果待确认，请先核实。' : '',
  storageError: bookingStore.error,
  success: false
};
const savedBooking = bookingStore.data.history[0];
if (savedBooking && ['success', 'cancelled', 'completed'].includes(savedBooking.outcome) && !state.pendingBooking) {
  state.booking = { ...savedBooking, remoteState: savedBooking.remoteState || (savedBooking.outcome === 'success' ? undefined : savedBooking.outcome) };
  state.success = savedBooking.outcome === 'success';
}

function completeBooking(booking, source) {
  const confirmed = { ...booking, confirmedBy: source };
  // Stop regardless of disk status: a confirmed booking must never trigger another submission.
  state.booking = confirmed;
  state.success = true;
  state.pendingBooking = null;
  state.bookingMessage = '';
  try { bookingStore.finish(confirmed, 'success'); }
  catch (e) { state.storageError = '预约已成功，但保存失败：' + e.message; log(state.storageError, 'error'); }
  log('★★★ 预约成功！座位：' + confirmed.seat + '（' + confirmed.area + '）', 'success');
  log('预约时间：' + confirmed.date + ' ' + confirmed.startTime + '–' + confirmed.endTime + '，请按官网要求签到。', 'success');
}

let cachedRecordsEndpoint = '';
async function fetchOwnReservations(cfg) {
  if (!cachedRecordsEndpoint) {
    let source;
    if (process.env.LIBSEAT_MOCK) {
      const mock = require(process.env.LIBSEAT_MOCK);
      if (!mock.recordAsset) throw Error('模拟接口未提供预约记录模块');
      source = mock.recordAsset;
    } else {
      source = await currentRecordsSource(async asset => {
        const response = await fetch(BASE + asset, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
        if (!response.ok) throw Error('无法读取官网预约记录模块');
        return response.text();
      });
    }
    cachedRecordsEndpoint = recordsEndpoint(source);
  }
  // Absence on these pages is never treated as proof that the submission failed.
  const records = [];
  for (let page = 1; page <= 3; page++) {
    const r = await api(cachedRecordsEndpoint, { type: '1', page, limit: 20 }, cfg.token, false, { priority: 'high' });
    if (!r || r.code !== 0 || !r.data || !Array.isArray(r.data.data)) throw Error('无法读取预约记录，请检查登录状态或在官网核实');
    records.push(...r.data.data);
    if (r.data.data.length < 20) break;
  }
  return records;
}

async function reconcileBooking() {
  if (!state.pendingBooking || state.checkingBooking) return;
  state.checkingBooking = true;
  state.bookingMessage = '正在查询官网预约记录…';
  const booking = state.pendingBooking;
  try {
    const records = await fetchOwnReservations(loadConfig());
    if (records.some(record => matchesRecord(record, booking))) completeBooking(booking, 'records');
    else state.bookingMessage = '暂未查到完全匹配的有效预约。请稍后重新核实，或打开官网确认；任务保持暂停。';
  } catch (e) { state.bookingMessage = '自动核实未完成：' + e.message + '。请打开官网核实。'; }
  finally { state.checkingBooking = false; }
}

let seatWatch = null;
const renewal = new Renewal(process.env.LIBSEAT_RENEWAL_FILE || path.join(path.dirname(CONFIG_FILE), 'renewal.json'), {
  config: loadConfig,
  stopSearch: () => { state.stopFlag = true; },
  booking: () => state.success ? state.booking : null,
  resolvedBooking: id => bookingStore.data.history.find(b => b.id === id),
  unavailable: () => state.running || !!state.pendingBooking || state.checkingBooking || !!state.storageError || management.blocked() || !!seatWatch?.blocks(),
  records: () => fetchOwnReservations(loadConfig()),
  prepare: async (booking, window) => {
    const cfg = loadConfig();
    let areaId = booking.areaId;
    if (!areaId) {
      const own = await api('/v4/index/subscribe', {}, cfg.token, false, { priority: 'high' });
      const row = own?.code === 0 && own.data?.find(r => String(r.type) === '1'
        && String(r.space_id || r.space) === String(booking.seatId));
      areaId = row?.area_id;
    }
    if (!areaId) throw Error('无法确认原座位所在区域');
    const map = await fetchSpaceMap({ ...cfg, dateMode: 'today', timeMode: 'now' }, String(areaId), booking.date, 'high');
    if (map?.code !== 0) throw Error(map?.message || '无法读取官网预约时段');
    const rule = resolveRenewalRule(map.data, booking, cfg, { start: window.startTime, end: window.endTime });
    return { areaId: String(areaId), startTime: rule.start, endTime: rule.end,
      reserveType: rule.reserveType, segment: rule.segment, axis: rule.axis };
  },
  // Verified against the official seat-record page: cancel({id: record.id}),
  // /h5/assets/index.1787201907183.js export `$`. Plain JSON, no automatic retries.
  cancel: (id, beforeSend) => api('/v4/space/cancel', { id }, loadConfig().token, false, {
    priority: 'high', beforeSend() {
      try { beforeSend(); } catch (e) { e.beforeSubmission = true; throw e; }
    }
  }),
  reserve: (booking, beforeSend) => {
    const cfg = loadConfig();
    const body = orderBody(booking.seatId, booking.date, { reserveType: booking.reserveType,
      segment: booking.segment, start: booking.startTime, end: booking.endTime });
    if (cfg.usePoints && cfg.lat && cfg.lng) body.points = { lat: Number(cfg.lat), lng: Number(cfg.lng), time: Math.floor(Date.now() / 1000) };
    return api('/v4/space/confirm', body, cfg.token, true, { priority: 'high', beforeSend() {
      try {
        beforeSend();
        const live = loadConfig();
        const invalid = validateSubmission({ ...live, ...renewal.job.axis, dateMode: 'today', timeMode: 'now' }, booking.date,
          { reserveType: booking.reserveType, segment: booking.segment, axis: booking.axis,
            start: booking.startTime, end: booking.endTime });
        if (invalid) throw Error(invalid);
        bookingStore.setPending(booking);
        state.pendingBooking = booking;
      } catch (e) { e.beforeSubmission = true; throw e; }
    } });
  },
  cancelled: booking => {
    state.success = false; state.booking = null;
    try { bookingStore.finish(booking, 'cancelled'); }
    catch (e) { state.storageError = e.message; throw e; }
  },
  cancelUnknown: () => { state.success = false; state.booking = null; },
  restore: booking => { state.booking = booking; state.success = true; },
  booked: booking => completeBooking(booking, 'response'),
  rejected: booking => {
    try { bookingStore.finish(booking, 'rejected'); state.pendingBooking = null; }
    catch (e) { state.storageError = e.message; throw e; }
  },
  reconcile: reconcileBooking
});
if (['cancel-unknown', 'booking-unknown', 'cancelled', 'booking'].includes(renewal.job?.phase)) {
  state.success = false; state.booking = null;
}
const management = new BookingManagement(bookingStore, {
  booking: () => state.booking,
  token: () => loadConfig().token,
  update: booking => { state.booking = booking; state.success = booking.outcome === 'success'; },
  unavailable: owner => state.running || !!state.pendingBooking || state.checkingBooking || !!state.storageError
    || !!(seatWatch?.busy && owner !== seatWatch)
    || renewal.busy || !!renewal.error || ['cancel-unknown', 'booking-unknown'].includes(renewal.job?.phase),
  stopRenewal: () => { if (renewal.job?.active) renewal.stop(); },
  records: () => fetchOwnReservations(loadConfig()),
  current: async () => {
    const r = await api('/v4/index/subscribe', {}, loadConfig().token, false, { priority: 'high' });
    if (r?.code !== 0 || !Array.isArray(r.data)) throw Error('无法读取官网当前座位信息');
    return r.data;
  },
  // Official AppointmentItem: cancel({id}); leave/checkout({id, points}) with AES.
  send: (action, body, beforeSend) => api('/v4/space/' + action, body, loadConfig().token, action !== 'cancel', { priority: 'high', beforeSend })
});
let watchLocation = null;
function saveWatchLocation(points) {
  if (Number.isFinite(points?.lat) && Number.isFinite(points?.lng) && Math.abs(points.lat) <= 90 && Math.abs(points.lng) <= 180)
    watchLocation = { lat: points.lat, lng: points.lng, at: Date.now() };
}
async function inspectWatchTarget(input, cfg, date) {
  const areaId = String(input?.areaId || '');
  if (!areaId || areaId.length > 100 || !(input.seatId || input.seat)) throw Error('请先选择地图区域并指定一个座位');
  const map = await fetchSpaceMap(cfg, areaId, date, 'high');
  if (map?.code !== 0) throw Error(map?.message || '无法读取目标区域的预约规则');
  const rule = resolveBookingRule(map.data, cfg, date, effectiveWindow(cfg, 'book'));
  const seats = await fetchSeats(cfg, areaId, date, 'high', rule);
  if (seats?.code !== 0 || !Array.isArray(seats.data?.list)) throw Error(seats?.message || '无法读取目标座位');
  const wanted = String(input.seat || '').trim().toUpperCase();
  const found = seats.data.list.filter(s => input.seatId ? String(s.id) === String(input.seatId)
    : String(s.no).toUpperCase() === wanted || /^\d+$/.test(wanted) && Number(String(s.no).match(/\d+$/)?.[0]) === Number(wanted));
  if (found.length !== 1 || !found[0].id) throw Error('无法唯一确定座位，请输入本区域完整座位编号');
  const s = found[0];
  return { target: { areaId, seatId: String(s.id), seat: String(s.no), area: map.data.name_merge || cfg.areaNames?.[areaId] || areaId },
    available: String(s.status) === '1', rule };
}
function adoptWatchBooking(booking) {
  const known = bookingStore.data.history.find(b => b.id === booking.id);
  if (!known || JSON.stringify(known) !== JSON.stringify(booking)) {
    const claims = new Set(bookingStore.data.claims);
    // Importing an existing seat must not trigger a "just grabbed" notification.
    claims.add('page:' + booking.id); claims.add('desktop:' + booking.id);
    bookingStore.write({ ...bookingStore.data, claims: [...claims].slice(-150),
      history: [booking, ...bookingStore.data.history.filter(b => b.id !== booking.id)].slice(0, 50) });
  }
  state.booking = booking; state.success = booking.outcome === 'success';
}
async function currentWatchBooking(cfg, date) {
  const records = await fetchOwnReservations(cfg);
  const response = await api('/v4/index/subscribe', {}, cfg.token, false, { priority: 'high' });
  if (response?.code !== 0 || !Array.isArray(response.data)) throw Error('无法核实官网当前座位，未释放原座位');
  if (loadConfig().token !== cfg.token) throw Error('登录状态已变化');
  const current = response.data.filter(r => String(r.type) === '1');
  const terminal = r => ['6', '4', '8', '12', '34', '35'].includes(String(r.status));
  const live = records.filter(r => !terminal(r) && (!r.endTime || !bookingEnded({ date: String(r.endTime).slice(0, 10), endTime: String(r.endTime).slice(11, 16) })));
  if (live.length > 1 || live.some(r => r.wait_id)) throw Error('有多笔有效预约或排队记录，无法确定应换出的座位，请在官网核实');
  if (!live.length) {
    if (current.length) throw Error('官网当前座位与预约记录不一致，请稍后核实');
    if (state.success && state.booking) {
      const old = findBooking(records, state.booking);
      if (!old || !terminal(old)) throw Error('原预约尚未确认结束，未预约其他座位');
      management.apply(state.booking, { record: old, ...describe(old) });
    }
    return null;
  }
  const row = live[0], subscription = current.find(r => String(r.id) === String(row.id));
  if (current.some(r => String(r.id) !== String(row.id))) throw Error('官网当前座位不唯一，请核实后再盯座');
  const detail = describe(row, subscription);
  if (!['reserved', 'signed', 'away'].includes(detail.state)) throw Error('无法识别当前预约状态，已保留原座位');
  const known = bookingStore.data.history.find(b => findBooking([row], b));
  const begin = String(row.beginTime || '').replace('T', ' ');
  const end = String(row.endTime || '').replace('T', ' ');
  if (begin.slice(0, 10) !== date || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(end)) throw Error('已有其他日期或时间不明的预约，未自动释放');
  const seatId = String(row.seat_id || row.space || row.space_id || subscription?.space_id || known?.seatId || '');
  const areaId = String(row.area_id || subscription?.area_id || known?.areaId
    || (seatId === seatWatch?.job?.target.seatId ? seatWatch.job.target.areaId : ''));
  if (!row.id || !seatId) throw Error('官网未提供完整的预约编号和座位信息');
  return { ...detail, booking: { ...known, id: known?.id || 'official-' + String(row.id), officialId: String(row.id),
    seatId, areaId, seat: String(row.name || row.no || row.spaceName || known?.seat || seatId),
    area: String(row.nameMerge || row.areaName || known?.area || areaId), date,
    startTime: begin.slice(11, 16), endTime: end.slice(11, 16), outcome: 'success', remoteState: detail.state } };
}
seatWatch = new SeatWatch(process.env.LIBSEAT_WATCH_FILE || path.join(path.dirname(CONFIG_FILE), 'seat-watch.json'), {
  config: loadConfig,
  unavailable: () => state.running || !!state.pendingBooking || state.checkingBooking || !!state.storageError
    || renewal.blocksBooking() || management.blocked(),
  inspect: inspectWatchTarget, current: currentWatchBooking, adopt: adoptWatchBooking,
  pending: () => ({ booking: state.pendingBooking, action: bookingStore.data.pendingAction }),
  resolved: id => bookingStore.data.history.find(b => b.id === id),
  validate: (candidate, cfg, date) => { const reason = validateSubmission(cfg, date, candidate.rule); if (reason) throw Error(reason); },
  release: (booking, action, beforeSend) => management.act({ id: booking.id, action,
    points: watchLocation && Date.now() - watchLocation.at < 60000 ? watchLocation : {} }, { owner: seatWatch, beforeSend }),
  reserve: (booking, candidate, cfg, beforeSend) => {
    const body = orderBody(booking.seatId, booking.date, candidate.rule);
    if (watchLocation && Date.now() - watchLocation.at < 60000)
      body.points = { lat: watchLocation.lat, lng: watchLocation.lng, time: Math.floor(Date.now() / 1000) };
    return api('/v4/space/confirm', body, cfg.token, true, { priority: 'high', beforeSend() {
      try {
        beforeSend();
        if (booking.reserveType === '1') {
          const now = new Date();
          const start = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
          if (start > booking.startTime) booking.startTime = start;
        }
        booking.bookedAt = new Date().toISOString();
        seatWatch.save({ ...seatWatch.job, attempt: booking });
        bookingStore.setPending(booking); state.pendingBooking = booking;
      } catch (e) { e.beforeSubmission = true; throw e; }
    } });
  },
  booked: booking => completeBooking(booking, 'response'),
  rejected: booking => { bookingStore.finish(booking, 'rejected'); state.pendingBooking = null; },
  reconcileBooking,
  reconcileRelease: () => management.refresh(true, seatWatch)
});
setInterval(() => seatWatch.tick().catch(e => log('盯座暂停：' + e.message, 'error')), 1000);

function expireBooking() {
  const booking = state.booking;
  // An uncertain submission/action must still be reconciled, never silently discarded.
  if (!state.success || !bookingEnded(booking) || state.pendingBooking || state.checkingBooking
      || state.running || management.blocked() || renewal.busy || seatWatch?.busy) return;
  const ended = { ...booking, outcome: 'completed', remoteState: 'completed', endedBy: 'time' };
  state.booking = ended; state.success = false;
  management.view = null;
  try {
    bookingStore.write({ ...bookingStore.data,
      history: [ended, ...bookingStore.data.history.filter(b => b.id !== ended.id)].slice(0, 50) });
  } catch (e) { state.storageError = '保存预约结束状态失败：' + e.message; }
}
expireBooking();
setInterval(() => {
  expireBooking();
  renewal.tick().catch(e => log('定时重约停止：' + e.message, 'error'));
}, 5000);

function log(msg, level) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + msg;
  state.logs.push({ t: Date.now(), msg: line, level: level || 'info' });
  if (state.logs.length > 500) state.logs.shift();
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) { /* ignore */ }
}

/* ============================================================
 * 六之二、自动登录 / 登录态自动续期
 * ------------------------------------------------------------
 * 原理：browser-data 目录保留 CAS 单点登录 cookie（CASTGC）。
 *   1. token 过期时，用【无头浏览器】静默打开站点 -> CAS 自动重定向
 *      -> 页面 JS 把新 token 写入 sessionStorage -> CDP 抓回并保存，
 *      全程无需人工操作（silent refresh）。
 *   2. 只有连 CAS 会话本身都过期时，才需要弹出可见浏览器登录一次。
 * ============================================================ */
const loginState = {
  active: false,
  mode: '',
  startedAt: 0,
  hint: '',
  elapsed: 0,
  error: '',
  tokenOk: false,
  generation: 0
};
let loginTask = null;
let loginController = null;
let manualLoginStarting = false;
const PROFILE_DIR = process.env.LIBSEAT_PROFILE_DIR || path.join(ROOT, 'browser-data');
const COOKIE_FILE = path.join(PROFILE_DIR, 'cookies.json');

/** 读取已保存的 cookie 快照 */
function loadSavedCookies() {
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  } catch (e) { return null; }
}

/** 把当前调试浏览器里的 csu.edu.cn cookie（含 CASTGC 会话 cookie）存盘 */
async function saveCookiesSnapshot() {
  try {
    const cookies = await browserLogin.getAllCookies();
    if (cookies.length) {
      fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf8');
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

/**
 * 统一的登录态获取流程
 * @param {object} opts
 *   headlessFirst  先尝试无头静默刷新
 *   allowHeaded    静默失败后是否弹出可见浏览器等待人工登录
 *   maxWaitSec     有头模式最长等待秒数
 */
function runLoginFlow(opts) {
  opts = opts || {};
  if (loginState.active) return loginTask || Promise.resolve({ ok: false, message: '已在登录流程中' });
  const controller = new AbortController();
  loginController = controller;
  const signal = controller.signal;
  const maxWaitSec = Math.min(300, Math.max(30, Number(opts.maxWaitSec) || 300));
  loginState.active = true;
  loginState.mode = opts.headlessFirst ? 'silent' : 'manual';
  loginState.startedAt = Date.now();
  loginState.error = '';
  loginState.tokenOk = false;
  loginState.elapsed = 0;
  loginState.hint = '正在刷新登录态...';

  const deadline = setTimeout(() => controller.abort(Error('登录流程超时，请重试')), (opts.allowHeaded === false ? 75 : maxWaitSec + 90) * 1000);

  // 启动浏览器后恢复上次保存的 cookie（CASTGC 是会话 cookie，必须手动注入）
  const launchAndRestore = async (headless) => {
    signal.throwIfAborted();
    loginState.mode = headless ? 'silent' : 'manual';
    loginState.hint = headless ? '正在启动后台登录检查…' : '正在打开学校登录窗口…';
    browserLogin.launchBrowser(PROFILE_DIR, { headless, startBlank: true });
    if (browserLogin.waitForReady) await browserLogin.waitForReady(signal);
    signal.throwIfAborted();
    const saved = loadSavedCookies();
    if (saved && saved.length) {
      const restored = await browserLogin.setAllCookies(saved, signal);
      if (restored) log('已恢复上次保存的登录 cookie（' + saved.length + ' 条）');
      else log('旧登录会话未能恢复，将打开学校登录页重新认证。', 'warn');
    }
    signal.throwIfAborted();
    // Restore cookies before the first navigation, otherwise the CAS redirect
    // races restoration and may get stuck on a login page in a hidden browser.
    if (browserLogin.openSite) await browserLogin.openSite(signal);
  };

  loginTask = (async () => {
  try {
    // 清掉可能残留的调试浏览器实例（避免端口/占用冲突）
    await browserLogin.closeBrowser();
    signal.throwIfAborted();

    /* ---- 第 1 步：无头静默刷新 ---- */
    if (opts.headlessFirst) {
      let silentResult;
      try {
        await launchAndRestore(true);
        const r = silentResult = await browserLogin.waitForToken(45000, (info) => {
          loginState.hint = '静默刷新登录态中...' + (info.hint || '');
        }, { signal, headless: true });
        signal.throwIfAborted();
        if (r && r.ok) {
          const cfg = loadConfig();
          cfg.token = r.token;
          saveConfig(cfg);
          loginState.tokenOk = true;
          loginState.generation = (loginState.generation || 0) + 1;
          loginState.hint = '登录态已自动续期（静默）';
          log('已自动续期登录态（静默模式，无需手动操作）', 'success');
          return { ok: true, silent: true };
        }
      } catch (e) { signal.throwIfAborted(); silentResult = { message: e.message }; }
      await browserLogin.closeBrowser();

      if (opts.allowHeaded === false) {
        loginState.error = silentResult?.message || '后台登录检查未成功，请点击“打开登录窗口”完成认证。';
        log(loginState.error, 'error');
        return { ok: false, needManual: !!silentResult?.needManual };
      }
    }

    /* ---- 第 2 步：弹出可见浏览器 ---- */
    loginState.hint = '已打开浏览器窗口，若未自动登录请在窗口中完成登录...';
    await launchAndRestore(false);
    const result = await browserLogin.waitForToken(
      maxWaitSec * 1000,
      (info) => { loginState.hint = info.hint; }, { signal, headless: false }
    );
    signal.throwIfAborted();

    if (result && result.ok) {
      const cfg = loadConfig();
      cfg.token = result.token;
      saveConfig(cfg);
      loginState.tokenOk = true;
      loginState.generation = (loginState.generation || 0) + 1;
      loginState.hint = '登录态已获取并保存';
      log('自动获取登录态成功，token 已保存', 'success');
      return { ok: true };
    }

    loginState.error = (result && result.message) || '未获取到登录态';
    log('自动获取登录态失败: ' + loginState.error, 'error');
    return { ok: false };
  } catch (e) {
    loginState.error = e.message;
    log('自动登录异常: ' + e.message, 'error');
    return { ok: false };
  } finally {
    clearTimeout(deadline);
    loginState.hint = loginState.tokenOk ? '登录成功，正在保存浏览器会话…' : '正在结束本次登录等待…';
    try {
      if (loginState.tokenOk) await saveCookiesSnapshot();
      await browserLogin.closeBrowser();
    } catch (e) { log('登录窗口清理未完成：' + e.message, 'warn'); }
    finally {
      loginState.elapsed = Math.round((Date.now() - loginState.startedAt) / 1000);
      loginState.active = false;
      loginState.mode = '';
      loginState.hint = loginState.tokenOk ? '登录态已获取并保存' : loginState.error;
    }
  }
  })();
  return loginTask;
}

/** 校验当前 token 是否有效。返回 true / false（网络异常返回 null，不当成失效） */
async function tokenValid(cfg) {
  const exp = tokenExpiry(cfg.token);
  if (!cfg.token || (exp && exp <= Date.now() / 1000)) return false;
  try {
    const r = await fetchAreas(cfg, targetDate(cfg));
    return r.code === 0;
  } catch (e) {
    return null;
  }
}

/**
 * 确保 cfg.token 可用；不可用则自动刷新并重载。
 * @param {object} opts allowHeaded - 失败后是否允许弹窗人工登录（后台任务传 false）
 * @returns {object|null} 刷新后的配置；失败返回 null
 */
async function ensureToken(cfg, opts) {
  opts = opts || {};
  let valid = await tokenValid(cfg);
  if (valid === true) return cfg;

  if (valid === false) log('登录态缺失或已过期，自动刷新...', 'warn');
  if (valid === null) log('网络异常，暂时无法校验登录态', 'warn');

  const r = await runLoginFlow({
    headlessFirst: true,
    allowHeaded: opts.allowHeaded !== false,
    maxWaitSec: 180
  });
  if (r.ok) return loadConfig();
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runOnce(cfg, date) {
  // 1. 查区域空闲数
  const pick = await fetchAreas(cfg, date);
  if (pick.code === 10001) {
    log('登录已失效（token 过期），请重新获取 token', 'error');
    return { fatal: true };
  }
  if (pick.code !== 0) {
    log('查询区域失败: ' + (pick.message || JSON.stringify(pick).slice(0, 120)), 'warn');
    return {};
  }

  const all = (pick.data && pick.data.area) || [];
  const selectedIds = selectedAreaIds(cfg);
  const targets = all.filter(a => selectedIds.includes(String(a.id)));
  state.lastAreas = targets.map(a => ({
    id: a.id, name: a.nameMerge || a.name,
    free: Number(a.free_num), total: Number(a.total_num)
  }));

  const summary = targets.map(a => (a.nameMerge || a.name) + ' 空' + a.free_num + '/' + a.total_num).join(' | ');
  const w = effectiveWindow(cfg, 'view');
  const planName = activePlanName(cfg);
  const prefAreaIds = (cfg.preferAreas || []).map(String);
  const prefAreaTxt = prefAreaIds.length
    ? prefAreaIds.map(id => (cfg.areaNames || {})[id] || id).join('、')
    : '全部';
  log('此刻状态（' + w.start + ' 快照）：' + (summary || '（未匹配到目标区域）')
    + '　[方案：' + (planName || (seatPrefs.normalizePrefs(cfg.seatPrefs).length ? '未命名' : '未设置'))
    + ' · 心仪区：' + prefAreaTxt + ']');

  const missing = selectedIds.filter(id => !targets.some(a => String(a.id) === id));
  if (missing.length) {
    state.lastFailure = '部分抢选区域未返回数据：' + missing.map(id => cfg.areaNames?.[id] || id).join('、');
    log(state.lastFailure, 'warn');
  }
  // Rotate the scan origin between rounds; list order is never a preference.
  const scope = targets.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const offset = scope.length ? state.areaCursor++ % scope.length : 0;
  const withFree = [...scope.slice(offset), ...scope.slice(0, offset)].filter(a => Number(a.free_num) > 0);
  if (!withFree.length) return {};

  // 2. 有空位 -> 拉座位明细
  let invalidTimeFailure = '';
  for (const area of withFree) {
    if (state.stopFlag) return {};
    let bookedWindow, seatRes;
    try {
      if (!cfg.verifyOnly) {
        const map = await fetchSpaceMap(cfg, area.id, date);
        if (map.code === 10001) return { fatal: true };
        if (map.code !== 0) throw Error(map.message || '无法读取官网预约规则');
        bookedWindow = resolveBookingRule(map.data, cfg, date, effectiveWindow(cfg, 'book'));
        log((area.nameMerge || area.name) + '：' + (bookedWindow.reserveType === '1' ? '官网整段预约 ' : '预约时段 ')
          + bookedWindow.start + '–' + bookedWindow.end);
      }
      if (state.stopFlag) return {};
      seatRes = await fetchSeats(cfg, area.id, date, undefined, bookedWindow);
    } catch (e) {
      state.lastFailure = (area.nameMerge || area.name) + '：' + e.message;
      log(state.lastFailure + '；继续检查其他抢选区域。', 'warn');
      continue;
    }
    if (seatRes.code === 10001) { log('登录已失效，请更新 token', 'error'); return { fatal: true }; }
    if (seatRes.code !== 0) {
      log('拉取座位失败(' + (area.nameMerge || area.name) + '): ' + (seatRes.message || ''), 'warn');
      continue;
    }
    const list = (seatRes.data && seatRes.data.list) || [];
    const freeSeats = list.filter(s => String(s.status) === '1');

    // 同步明细口径到界面数据（pick 汇总值在过期时段不可信）
    const tracked = state.lastAreas.find(x => String(x.id) === String(area.id));
    if (tracked) tracked.seatFree = freeSeats.length;

    if (!freeSeats.length) {
      log('  ' + (area.nameMerge || area.name) + '：暂无空闲座位', 'info');
      continue;
    }

    // 按心仪座位优先级生成候选顺序
    const localPref = seatPrefs.areaPreference(cfg, area.id);
    const prefs = localPref.seats;
    const candidates = orderCandidates(cfg, freeSeats, area.id);
    const prefHit = candidates.filter(c => c.pref);

    if (prefs.length) {
      log('心仪座位（' + (area.nameMerge || area.name) + '）可约情况：'
        + (prefHit.length ? prefHit.map(c => c.seat.no).join(', ') : '暂无可约'),
        prefHit.length ? 'hit' : 'warn');
      if (!prefHit.length && localPref.mode === 'prefer') log('优先座位暂无空位，尝试本区域其他空闲座位。');
    }

    if (!candidates.length) {
      log('  ' + (area.nameMerge || area.name) + '：共 ' + freeSeats.length
        + ' 个空闲座位，但都不在你的心仪列表内（当前为"只抢心仪座位"模式），继续等待。', 'warn');
      continue;
    }

    log('候选座位 ' + candidates.length + ' 个（' + (area.nameMerge || area.name) + '）：'
      + candidates.slice(0, 8).map(c => c.seat.no + (c.pref ? '★' : '')).join(', ')
      + (candidates.length > 8 ? ' ...' : '') + '（★ = 心仪座位）', 'hit');

    if (cfg.verifyOnly) {
      log('【安全模式】仅观察，不提交预约。首选将是 ' + candidates[0].seat.no
        + (candidates[0].pref ? '（心仪）' : '（任意空闲）') + '。确认无误后可在界面关闭此开关。', 'warn');
      return { hit: true, seats: candidates.map(c => c.seat.no) };
    }

    // Try all available preferences, then up to three other seats from this area.
    // Preferred seats lost in a race must not exhaust the fallback attempt budget.
    const attempts = [...candidates.filter(c => c.pref), ...candidates.filter(c => !c.pref).slice(0, 3)];
    for (const cand of attempts) {
      if (state.stopFlag) return {};
      const seat = cand.seat;
      log('尝试预约座位 ' + seat.no + (cand.pref ? '（心仪座位）' : '（任意空闲）') + ' ...', 'info');
      const booking = {
        id: crypto.randomUUID(), seat: String(seat.no), seatId: String(seat.id),
        areaId: String(area.id), reserveType: bookedWindow.reserveType, segment: bookedWindow.segment,
        area: area.nameMerge || area.name || String(area.id),
        date: date, startTime: bookedWindow.start, endTime: bookedWindow.end,
        bookedAt: new Date().toISOString()
      };
      let order;
      try { order = await submitOrder(cfg, seat.id, date, bookedWindow, booking); }
      catch (e) {
        if (e.beforeSubmission) {
          log('未提交预约：' + e.message, 'warn');
          if (e.storageFailure) { state.storageError = e.message; return { halt: true }; }
          return {};
        }
        log('预约请求未获得确定结果，暂停抢座并查询已有预约：' + e.message, 'warn');
        await reconcileBooking();
        return { halt: true };
      }
      state.orderResult = order;

      if (order && order.code === 0) {
        state.lastFailure = '';
        completeBooking(booking, 'response');
        return { done: true, seat: seat.no, area: area.nameMerge || area.name };
      }

      if (!order || !Number.isInteger(order.code) || order.code < 0) {
        log('预约响应无法确认成功或失败，暂停抢座并核实。', 'warn');
        await reconcileBooking();
        return { halt: true };
      }
      try { bookingStore.finish(booking, 'rejected'); state.pendingBooking = null; }
      catch (e) { state.storageError = e.message; return { halt: true }; }

      state.lastFailure = '座位 ' + seat.no + ' 预约失败：' + (order.message || '错误码 ' + order.code);
      log(state.lastFailure, 'error');
      if (order.code === 10001) return { fatal: true };
      if (/未选择或申请时间错误/.test(order.message || '')) {
        invalidTimeFailure = state.lastFailure;
        break; // Another area may use different rules; finish checking the list first.
      }
    }
  }
  if (invalidTimeFailure) {
    state.stopReason = invalidTimeFailure + '。其他抢选区域也未预约成功，任务已停止，请核对官网预约规则。';
    return { halt: true };
  }
  return {};
}

async function engineLoop(cfg) {
  const date = targetDate(cfg);
  state.running = true;
  state.stopFlag = false;
  state.success = false;
  state.orderResult = null;
  state.lastFailure = '';
  state.areaCursor = 0;
  state.booking = null;
  state.stopReason = '';

  log('===== 开始抢座 =====');
  log('抢选区域（无优先级，有空位即尝试）：' + selectedAreaIds(cfg).map(id => cfg.areaNames[id] || id).join('、'));
  log('目标日期：' + date + (cfg.dateMode === 'tomorrow' ? '（次日）' : '（当日）'));
  if (cfg.timeMode === 'now') {
    log('查询方式：实时同步（' + windowLabel(cfg) + '）');
    const wv = effectiveWindow(cfg, 'view');
    if (wv.start === wv.end) {
      log('⚠ 当前时间已超出开放时间轴（' + (cfg.axisEnd || '22:00') + '），请切换日期或调整时间轴。', 'warn');
    }
  } else {
    log('时段模式：固定 ' + cfg.startTime + ' - ' + cfg.endTime);
  }
  log('轮询间隔：' + cfg.interval + ' 秒；模式：' + (cfg.verifyOnly ? '安全观察（不预约）' : '实抢'));

  // 时段有效性检查：官方接口对已过去的时段会返回虚高的 free_num，与座位明细严重不符
  if (windowPassed(cfg)) {
    log('⚠ 目标时段 ' + cfg.startTime + '-' + cfg.endTime + ' 已经过去：接口汇总的"空闲数"会明显虚高（例如汇总 35 而明细可约仅 10），不具备实时参考意义。', 'warn');
    log('⚠ 界面请以"明细可约"为准；并建议把时间段改为当前时刻之后的未来时段。', 'warn');
    if (!cfg.verifyOnly) {
      log('实抢模式下目标时段已过期，任务取消，避免无效预约请求。请修改时间段后重新开始。', 'error');
      state.running = false;
      log('===== 已停止 =====');
      return;
    }
  }

  // 开跑前先确保登录态可用（过期会自动静默刷新）
  const startAreas = (cfg.preferAreas || []).map(String);
  log('心仪方案：' + (activePlanName(cfg) || '未命名')
    + '　座位按各区域偏好选择，优先座位不可约时尝试本区其他空位'
    + '　心仪区 ' + (startAreas.length ? startAreas.map(id => (cfg.areaNames || {})[id] || id).join('、') : '（全部目标区）'));

  const ready = await ensureToken(cfg, { allowHeaded: true });
  if (!ready) {
    log('无法获取有效登录态，任务未开始。请在界面点「一键获取登录态」后重试。', 'error');
    state.running = false;
    log('===== 已停止 =====');
    return;
  }
  cfg = ready;
  log('登录态校验通过，开始轮询。');

  let attempts = 0;
  let refreshCount = 0;
  while (!state.stopFlag) {
    // 每轮重新读取配置：运行中切换心仪方案、改轮询间隔、换日期都能立即生效；
    // 顺带解决"看门狗在后台刷新了 token，而循环还拿着旧 token"的问题
    const live = loadConfig();
    const date = targetDate(live);
    if (!live.verifyOnly && live.timeMode === 'custom') {
      const invalid = validateBookingWindow(live, date, effectiveWindow(live, 'book'));
      if (invalid) { state.stopReason = invalid; log('任务停止：' + invalid, 'error'); break; }
    }
    attempts++;
    try {
      const r = await runOnce(live, date);
      state.lastCheck = Date.now();

      if (r && r.done) { log('任务完成，已停止。'); break; }
      if (r && r.halt) break;
      if (r && r.fatal) {
        // 登录失效：自动刷新后继续，而不是直接中止
        refreshCount++;
        if (refreshCount <= 3 && !loginState.active) {
          log('登录失效，自动刷新登录态后继续（第 ' + refreshCount + ' 次）...', 'warn');
          const again = await ensureToken(live, { allowHeaded: false });
          if (again) { continue; }
          log('自动刷新失败（CAS 登录也已过期）。请在界面点「一键获取登录态」完成一次人工登录。', 'error');
        }
        log('任务中止。');
        break;
      }
    } catch (e) {
      log('请求异常：' + e.message, 'warn');
      if (state.pendingBooking || state.success) break;
    }

    if (live.maxAttempts > 0 && attempts >= live.maxAttempts) {
      log('已达最大轮询次数 ' + live.maxAttempts + '，停止。');
      break;
    }
    if (state.stopFlag) break;

    // 可中断的等待（间隔改动下一轮即生效）
    const waitMs = Math.max(1, Number(live.interval) || 6) * 1000;
    const step = 200;
    for (let w = 0; w < waitMs && !state.stopFlag; w += step) await sleep(step);
  }

  state.running = false;
  log('===== 已停止 =====');
}

/* ============================================================
 * 七、HTTP 服务（静态页 + 控制接口）
 * ============================================================ */
function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({}); }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

/** 静态资源：只允许 public/ 下的单层文件名（防目录穿越） */
function serveStatic(res, urlPath) {
  let name = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (!name || name.indexOf('..') !== -1 || name.indexOf('/') !== -1 || name.indexOf('\\') !== -1) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }
  const file = path.join(ROOT, 'public', name);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    const ext = path.extname(name).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Code must be revalidated together with HTML after an application update.
      'Cache-Control': ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p.startsWith('/api/')) expireBooking();

  // ---- 静态页面 / 资源（含 App 图标、PWA 清单） ----
  if ((req.method === 'GET' || req.method === 'HEAD') && !p.startsWith('/api/')) {
    return serveStatic(res, p);
  }

  // Expired credentials cannot load the map. Return promptly instead of queueing network requests.
  if (['/api/tree', '/api/areas-of-storey', '/api/seats', '/api/areas', '/api/seat-status'].includes(p)) {
    const cfg = loadConfig();
    const exp = tokenExpiry(cfg.token);
    if (!cfg.token || (exp && exp <= Date.now() / 1000)) {
      return sendJson(res, { ok: false, code: 10001,
        message: cfg.token ? '登录已过期，请点击“重新登录”获取登录态' : '请先登录学校账号，再加载座位地图' });
    }
  }

  // ---- 获取配置 ----
  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, { ok: true, config: publicConfig(loadConfig()) });
  }

  // ---- 查询指定座位的当前状态（心仪座位状态刷新） ----
  if (p === '/api/seat-status' && req.method === 'POST') {
    const cfg = loadConfig();
    if (!cfg.token) return sendJson(res, { ok: false, message: '尚未获取登录态' });

    const body = await readBody(req);
    const want = seatPrefs.normalizePrefs(
      (Array.isArray(body.seats) && body.seats.length) ? body.seats : cfg.seatPrefs);

    if (!want.length) {
      return sendJson(res, { ok: true, seats: [], free: 0, total: 0, unknown: [], syncedAt: nowText() });
    }

    try {
      const date = targetDate(cfg);
      const found = new Map();

      for (const areaId of cfg.areaIds) {
        const r = await fetchSeats(cfg, String(areaId), date, 'high');
        if (r.code === 10001) return sendJson(res, { ok: false, message: '登录已失效', code: 10001 });
        if (r.code !== 0) continue;

        const list = (r.data && r.data.list) || [];
        list.forEach(s => {
          const no = String(s.no).toUpperCase();
          if (want.indexOf(no) !== -1 && !found.has(no)) {
            found.set(no, {
              no: s.no,
              status: String(s.status),
              statusName: s.status_name || '',
              areaId: String(areaId),
              areaName: (cfg.areaNames || {})[String(areaId)] || String(areaId)
            });
          }
        });
        if (found.size === want.length) break;   // 全找到就不再查其它区域
      }

      const seats = want.map(no => found.get(no) ||
        { no: no, status: '', statusName: '未找到', areaId: '', areaName: '' });

      return sendJson(res, {
        ok: true,
        syncedAt: nowText(),
        window: effectiveWindow(cfg, 'view'),
        seats: seats,
        free: seats.filter(s => s.status === '1').length,
        total: seats.length,
        unknown: seats.filter(s => !s.status).map(s => s.no)
      });
    } catch (e) {
      return sendJson(res, { ok: false, message: '网络错误: ' + e.message });
    }
  }

  // ---- 切换心仪座位方案（立即生效，运行中也无需重启） ----
  if (p === '/api/plan-activate' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    const plans = cfg.seatPlans || [];
    const plan = plans.find(x => x && String(x.id) === String(body.id));

    if (!plan) {
      // 支持传 seats 直接激活（前端"另存并启用"）
      if (Array.isArray(body.seats)) {
        cfg.seatPrefs = seatPrefs.normalizePrefs(body.seats);
        if (body.mode) cfg.seatPrefMode = body.mode;
        cfg.activePlanId = body.id ? String(body.id) : cfg.activePlanId;
        saveConfig(cfg);
        log('心仪座位已更新（' + cfg.seatPrefs.length + ' 个座位）', 'success');
        return sendJson(res, { ok: true, config: publicConfig(cfg) });
      }
      return sendJson(res, { ok: false, message: '方案不存在' });
    }

    cfg.seatPrefs = seatPrefs.normalizePrefs(plan.seats);
    cfg.areaSeatPrefs = areaSeatPrefs.snapshot(plan.areas, plan.areaSeatPrefs);
    if (plan.mode) cfg.seatPrefMode = plan.mode;
    if (Array.isArray(plan.areas)) cfg.preferAreas = plan.areas.map(String);
    if (plan.dateMode) cfg.dateMode = plan.dateMode;
    if (plan.interval) cfg.interval = Number(plan.interval) || cfg.interval;
    cfg.activePlanId = String(plan.id);
    saveConfig(cfg);
    const areaTxt = (cfg.preferAreas || []).length
      ? '　区域：' + cfg.preferAreas.map(id => (cfg.areaNames || {})[id] || id).join('、') : '';
    log('已切换到心仪方案「' + (plan.name || plan.id) + '」，共 ' + cfg.seatPrefs.length + ' 个座位：'
      + (cfg.seatPrefs.join(', ') || '（未指定座位，将抢区域内任意空位）') + areaTxt, 'success');
    return sendJson(res, { ok: true, config: publicConfig(cfg) });
  }

  // ---- 删除方案 ----
  if (p === '/api/plan-delete' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    const before = (cfg.seatPlans || []).length;
    cfg.seatPlans = (cfg.seatPlans || []).filter(x => x && String(x.id) !== String(body.id));
    let switchedTo = '';
    if (String(cfg.activePlanId) === String(body.id)) {
      // 删掉的正是当前方案：自动切到剩下第一个，保持状态一致
      const next = cfg.seatPlans[0];
      if (next) {
        cfg.activePlanId = String(next.id);
        cfg.seatPrefs = seatPrefs.normalizePrefs(next.seats);
        cfg.preferAreas = (next.areas || []).map(String);
        cfg.areaSeatPrefs = areaSeatPrefs.snapshot(next.areas, next.areaSeatPrefs);
        if (next.mode) cfg.seatPrefMode = next.mode;
        switchedTo = next.name || next.id;
      } else {
        cfg.activePlanId = '';
        cfg.seatPrefs = [];
      }
    }
    saveConfig(cfg);
    log('已删除心仪方案（剩 ' + cfg.seatPlans.length + ' 个' + (before === cfg.seatPlans.length ? '，未找到该方案' : '') + '）'
      + (switchedTo ? '，已自动切换到「' + switchedTo + '」' : ''));
    return sendJson(res, { ok: true, config: publicConfig(cfg) });
  }

  // ---- 保存配置 ----
  if (p === '/api/area-seat-preferences' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const id = String(body.areaId || '');
      if (!body.preference) throw Error('请提供座位偏好');
      const normalized = areaSeatPrefs.normalizeMap({ [id]: body.preference });
      const cfg = loadConfig();
      cfg.areaSeatPrefs = { ...cfg.areaSeatPrefs, ...normalized };
      saveConfig(cfg);
      log('已保存 ' + ((cfg.areaNames || {})[id] || id) + ' 的座位偏好：' + areaSeatPrefs.summary(normalized[id]));
      return sendJson(res, { ok: true, config: publicConfig(cfg) });
    } catch (e) { return sendJson(res, { ok: false, message: e.message }); }
  }
  if (p === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      if (Object.hasOwn(body, 'areaSeatPrefs')) body.areaSeatPrefs = areaSeatPrefs.normalizeMap(body.areaSeatPrefs);
      if (Object.hasOwn(body, 'seatPlans')) {
        if (!Array.isArray(body.seatPlans)) throw Error('方案列表无效');
        body.seatPlans = body.seatPlans.map(plan => ({ ...plan, areaSeatPrefs: areaSeatPrefs.snapshot(plan.areas, plan.areaSeatPrefs) }));
      }
    } catch (e) { return sendJson(res, { ok: false, message: e.message }); }
    const cfg = loadConfig();
    Object.keys(body).forEach(k => { if (k in DEFAULT_CONFIG) cfg[k] = body[k]; });
    saveConfig(cfg);
    log('配置已保存');
    return sendJson(res, { ok: true });
  }

  // ---- 自动登录：弹出浏览器让用户登录，自动抓取 token ----
  if (p === '/api/auto-login' && req.method === 'POST') {
    const body = await readBody(req);
    if (manualLoginStarting) return sendJson(res, { ok: true, message: '正在打开登录窗口' });
    if (loginState.active && loginState.mode === 'manual') {
      browserLogin.focusLogin?.().catch(() => {});
      return sendJson(res, { ok: true, message: '请在已打开的学校窗口完成登录，或先停止等待再重试' });
    }
    manualLoginStarting = true;
    try {
      if (loginState.active) {
        loginController?.abort(Error('已切换到手动登录'));
        await loginTask;
      }
      runLoginFlow({ headlessFirst: false, allowHeaded: true, maxWaitSec: body.maxWaitSec || 300 });
      return sendJson(res, { ok: true });
    } finally { manualLoginStarting = false; }
  }

  if (p === '/api/login-cancel' && req.method === 'POST') {
    if (loginState.active) loginController?.abort(Error('已停止等待登录，可重新打开登录窗口'));
    return sendJson(res, { ok: true });
  }

  if (p === '/api/login-status' && req.method === 'GET') {
    return sendJson(res, {
      active: loginState.active,
      mode: loginState.mode,
      hint: loginState.hint,
      elapsed: loginState.active ? Math.round((Date.now() - loginState.startedAt) / 1000) : loginState.elapsed,
      error: loginState.error,
      tokenOk: loginState.tokenOk && !(tokenExpiry(loadConfig().token) && tokenExpiry(loadConfig().token) <= Date.now() / 1000),
      generation: loginState.generation
    });
  }

  // ---- 校验 token（失效时自动续期后重试） ----
  if (p === '/api/verify' && req.method === 'POST') {
    const body = await readBody(req);
    let cfg = loadConfig();
    if (body.token) cfg.token = body.token;
    if (!cfg.token && cfg.autoRefresh === false) return sendJson(res, { ok: false, message: '请先填写 token 或开启自动续期' });
    saveConfig(cfg);
    try {
      const date = targetDate(cfg);
      let r = await fetchAreas(cfg, date);
      if (r.code === 10001 && cfg.autoRefresh !== false && !loginState.active) {
        log('校验发现 token 已过期，自动刷新登录态...', 'warn');
        const again = await runLoginFlow({ headlessFirst: true, allowHeaded: true, maxWaitSec: 180 });
        if (again.ok) {
          cfg = loadConfig();
          r = await fetchAreas(cfg, date);
        }
      }
      if (r.code === 0) {
        const st = await collectAreaStatus(cfg, date, 'high');
        const stale = windowPassed(cfg);
        if (stale) {
          log('注意：目标时段 ' + cfg.startTime + '-' + cfg.endTime + ' 已过去，接口汇总值不可作为实时空闲依据（以明细可约数为准）', 'warn');
        }
        return sendJson(res, {
          ok: true,
          message: 'token 有效',
          date: date,
          stale: stale,
          window: st.window,
          bookWindow: st.bookWindow,
          label: st.label,
          syncedAt: st.syncedAt,
          mode: st.mode,
          areas: st.areas || []
        });
      }
      return sendJson(res, { ok: false, message: r.message || '校验失败', code: r.code });
    } catch (e) {
      return sendJson(res, { ok: false, message: '网络错误: ' + e.message });
    }
  }

  // ---- 三级结构：校区(馆) → 楼层 → 区域 ----
  if (p === '/api/tree' && (req.method === 'GET' || req.method === 'POST')) {
    const cfg = loadConfig();
    if (!cfg.token) return sendJson(res, { ok: false, message: '尚未获取登录态' });
    try {
      const r = await api('/v4/space/index', {}, cfg.token, false, { priority: 'high' });
      if (r.code !== 0) return sendJson(res, { ok: false, message: r.message || '获取楼层结构失败', code: r.code });

      const premises = (r.data && r.data.premises) || [];
      const storeys = (r.data && r.data.storey) || [];
      const byPremise = {};
      premises.forEach(pm => { byPremise[pm.id] = []; });
      storeys.forEach(st => {
        (st.list || []).forEach(it => {
          if (byPremise[it.parentId]) byPremise[it.parentId].push({ id: String(it.id), name: st.name });
        });
      });
      // 楼层顺序：按 storey 数组出现顺序（官方已排好）
      const order = {};
      storeys.forEach((st, i) => { order[st.name] = i; });
      const tree = premises.map(pm => ({
        id: String(pm.id),
        name: pm.name,
        storeys: (byPremise[pm.id] || []).sort((a, b) => (order[a.name] || 0) - (order[b.name] || 0))
      })).filter(pm => pm.storeys.length);

      return sendJson(res, { ok: true, tree: tree, current: { premiseId: (cfg.premisesIds || [])[0] || '', storeyId: (cfg.storeyIds || [])[0] || '' } });
    } catch (e) {
      return sendJson(res, { ok: false, message: '网络错误: ' + e.message });
    }
  }

  // ---- 某楼层下的区域列表（供三级下拉使用，不影响抢座范围） ----
  if (p === '/api/areas-of-storey' && req.method === 'POST') {
    const cfg = loadConfig();
    if (!cfg.token) return sendJson(res, { ok: false, message: '尚未获取登录态' });
    const body = await readBody(req);
    const premiseId = String(body.premiseId || (cfg.premisesIds || [])[0] || '');
    const storeyId = String(body.storeyId || (cfg.storeyIds || [])[0] || '');
    try {
      const date = targetDate(cfg);
      const w = effectiveWindow(cfg, 'view');
      const r = await api('/v4/space/pick', {
        premisesIds: [premiseId],
        categoryIds: [],
        storeyIds: [storeyId],
        boutiqueIds: [],
        date: date,
        start_time: w.start,
        end_time: w.end
      }, cfg.token, false, { priority: 'high' });
      if (r.code !== 0) return sendJson(res, { ok: false, message: r.message || '获取区域失败', code: r.code });

      const targets = (cfg.areaIds || []).map(String);
      const areas = ((r.data && r.data.area) || []).map(a => ({
        id: String(a.id),
        name: a.nameMerge || a.name,
        short: a.name,
        free: Number(a.free_num),
        total: Number(a.total_num),
        isTarget: targets.indexOf(String(a.id)) !== -1
      }));
      return sendJson(res, { ok: true, date: date, window: w, areas: areas, preferAreas: cfg.preferAreas || [] });
    } catch (e) {
      return sendJson(res, { ok: false, message: '网络错误: ' + e.message });
    }
  }

  // ---- 选座图：某区域的座位布局 + 实时状态 + 楼层底图 ----
  if (p === '/api/seats' && req.method === 'POST') {
    let cfg = loadConfig();
    if (!cfg.token) return sendJson(res, { ok: false, message: '请先填写 token' });
    const body = await readBody(req);
    const areaId = String(body.areaId || cfg.areaIds[0] || '');
    const own = body.bookingId && state.success && state.booking?.id === body.bookingId ? state.booking : null;
    if (own) cfg = { ...cfg, dateMode: own.date === targetDate({ dateMode: 'today' }) ? 'today' : 'tomorrow' };
    try {
      const date = own?.date || targetDate(cfg);
      const w = effectiveWindow(cfg, 'view');

      const [sr, mr] = await Promise.all([
        fetchSeats(cfg, areaId, date, 'high'),
        fetchSpaceMap(cfg, areaId, date, 'high')
      ]);

      if (sr.code === 10001) return sendJson(res, { ok: false, message: '登录已失效', code: 10001 });
      if (sr.code !== 0) return sendJson(res, { ok: false, message: sr.message || '拉取座位失败', code: sr.code });

      const list = (sr.data && sr.data.list) || [];
      const mapData = (mr && mr.data) || {};

      const prefs = seatPrefs.areaPreference(cfg, areaId).seats;
      const exist = new Set(list.map(s => String(s.no).toUpperCase()));

      // 可选区域：配置里的目标区 + 地图接口给出的同层其它区
      const cfgAreas = (cfg.areaIds || []).map(String);
      const siblings = mapData.brother_area || [];
      const areaOptions = [];
      const seen = new Set();
      const pushArea = (id, name, short, free, total, isTarget) => {
        const key = String(id);
        if (seen.has(key)) return;
        seen.add(key);
        areaOptions.push({
          id: key, name: name,
          short: short || String(name || '').split('-').pop() || name,
          free: free, total: total, isTarget: !!isTarget
        });
      };
      const selfName = mapData.name_merge || (cfg.areaNames || {})[areaId] || areaId;
      pushArea(areaId, selfName, mapData.name,
        list.filter(x => String(x.status) === '1').length, list.length, cfgAreas.includes(String(areaId)));
      siblings.forEach(b => pushArea(b.id, b.name_merge || b.name, b.name,
        Number(b.free_num), Number(b.total_num), cfgAreas.includes(String(b.id))));
      (cfg.areaIds || []).forEach(id => {
        if (!seen.has(String(id))) {
          const nm = (cfg.areaNames || {})[String(id)] || String(id);
          pushArea(id, nm, String(nm).split('-').pop(), null, null, true);
        }
      });

      return sendJson(res, {
        ok: true,
        date: date,
        window: w,
        syncedAt: nowText(),
        plane: mapData.web_plane || null,
        view: areaView(list),
        planeSize: { w: 1365, h: 768 },
        areas: areaOptions,
        preferAreas: cfg.preferAreas || [],
        area: {
          id: areaId,
          name: mapData.name_merge || (mapData.name ? mapData.name : areaId),
          total: list.length,
          free: list.filter(s => String(s.status) === '1').length
        },
        seats: list.map(s => ({
          id: s.id, no: s.no, label: s.name,
          x: Number(s.point_x), y: Number(s.point_y),
          w: Number(s.width), h: Number(s.height),
          status: String(s.status), statusName: s.status_name || ''
        })),
        prefs: prefs,
        unknownPrefs: prefs.filter(p => !exist.has(p))
      });
    } catch (e) {
      return sendJson(res, { ok: false, message: '网络错误: ' + e.message });
    }
  }

  // ---- 查询区域 ----
  if (p === '/api/areas' && req.method === 'POST') {
    const cfg = loadConfig();
    if (!cfg.token) return sendJson(res, { ok: false, message: '请先填写 token' });
    try {
      const date = targetDate(cfg);
      const st = await collectAreaStatus(cfg, date, 'high');
      if (st.code !== 0) return sendJson(res, { ok: false, message: st.message, code: st.code });
      return sendJson(res, {
        ok: true, date: date, stale: st.stale, window: st.window,
        bookWindow: st.bookWindow, label: st.label, syncedAt: st.syncedAt,
        mode: st.mode, areas: st.areas
      });
    } catch (e) {
      return sendJson(res, { ok: false, message: e.message });
    }
  }

  // ---- 开始 / 停止 ----
  if (p.startsWith('/api/renewal/')) {
    try {
      if (req.method !== 'POST') return sendJson(res, { ok: false, message: '请使用 POST' });
      if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return sendJson(res, { ok: false, message: '请求来源不匹配' });
      const body = await readBody(req);
      if (p === '/api/renewal/start') await renewal.start(body);
      else if (p === '/api/renewal/stop') renewal.stop();
      else if (p === '/api/renewal/check') await renewal.check();
      else return sendJson(res, { ok: false, message: '未知定时重约操作' });
      return sendJson(res, { ok: true, renewal: renewal.status() });
    } catch (e) { return sendJson(res, { ok: false, message: e.message, renewal: renewal.status() }); }
  }
  if (['/api/watch-start', '/api/watch-stop', '/api/watch-check', '/api/watch-location'].includes(p) && req.method === 'POST') {
    if (req.headers?.origin && req.headers.origin !== 'http://' + req.headers.host) return sendJson(res, { ok: false, message: '请求来源不匹配' });
    try {
      const body = await readBody(req);
      if (p === '/api/watch-start') { saveWatchLocation(body.points); await seatWatch.start(body); }
      else if (p === '/api/watch-stop') seatWatch.stop();
      else if (p === '/api/watch-check') await seatWatch.check();
      else saveWatchLocation(body.points);
      return sendJson(res, { ok: true, seatWatch: seatWatch.status() });
    } catch (e) { return sendJson(res, { ok: false, message: e.message, seatWatch: seatWatch.status() }); }
  }
  if (['/api/booking-state', '/api/booking-action'].includes(p) && req.method === 'POST') {
    if (req.headers?.origin && req.headers.origin !== 'http://' + req.headers.host) return sendJson(res, { ok: false, message: '请求来源不匹配' });
    try {
      const body = await readBody(req);
      if (p === '/api/booking-state') await management.refresh(true);
      else {
        if (seatWatch.blocks()) throw Error('请先停止盯座并核实待处理结果，再操作当前预约');
        await management.act(body);
      }
      return sendJson(res, { ok: true, bookingManagement: management.status() });
    } catch (e) { return sendJson(res, { ok: false, message: e.message, bookingManagement: management.status() }); }
  }
  if (p === '/api/bookings' && req.method === 'GET') {
    return sendJson(res, { ok: true, history: bookingStore.data.history });
  }
  if (p === '/api/booking-check' && req.method === 'POST') {
    if (!state.checkingBooking && state.pendingBooking) reconcileBooking();
    return sendJson(res, { ok: true });
  }
  if (p === '/api/booking-resolve' && req.method === 'POST') {
    const body = await readBody(req);
    const booking = state.pendingBooking;
    if (state.running || state.checkingBooking || !booking || body.id !== booking.id
        || body.confirmed !== true || !['success', 'not-booked'].includes(body.outcome)) {
      return sendJson(res, { ok: false, message: '请等待核实结束，并确认对应的官网预约结果' });
    }
    try {
      if (body.outcome === 'success') completeBooking(booking, 'user');
      else {
        bookingStore.finish(booking, 'not-booked');
        state.pendingBooking = null;
        state.bookingMessage = '已记录你在官网确认的结果：未预约成功。可手动重新开始。';
        log(state.bookingMessage);
      }
      return sendJson(res, { ok: true });
    } catch (e) { return sendJson(res, { ok: false, message: e.message }); }
  }
  if (p === '/api/notification-claim' && req.method === 'POST') {
    const body = await readBody(req);
    if (!['page', 'desktop'].includes(body.channel)) return sendJson(res, { ok: false, claimed: false });
    if (state.storageError && state.booking && state.booking.id === body.id) return sendJson(res, { ok: false, message: state.storageError });
    try { return sendJson(res, { ok: true, claimed: bookingStore.claim(body.id, body.channel) }); }
    catch (e) { return sendJson(res, { ok: false, message: e.message }); }
  }
  if (p === '/api/start' && req.method === 'POST') {
    const body = await readBody(req);
    if (seatWatch.blocks()) return sendJson(res, { ok: false, message: '请先停止盯座并处理待核实结果' });
    if (management.blocked()) return sendJson(res, { ok: false, message: '预约操作进行中或结果待核实，请先刷新预约状态' });
    if (state.running) return sendJson(res, { ok: false, message: '已在运行中' });
    if (renewal.blocksBooking() && renewal.job?.phase !== 'armed') return sendJson(res, { ok: false, message: '定时重约计划正在管理预约，请先停止或核实计划' });
    if (renewal.busy || renewal.error) return sendJson(res, { ok: false, message: renewal.error || '定时重约操作进行中，请稍后再试' });
    if (state.pendingBooking || bookingStore.data.pending) return sendJson(res, { ok: false, message: '上一笔预约结果待确认，请先核实，避免重复预约' });
    if (state.storageError) return sendJson(res, { ok: false, message: state.storageError });
    const cfg = loadConfig();
    for (const key of ['dateMode', 'timeMode', 'interval', 'startTime', 'endTime', 'verifyOnly']) {
      if (Object.prototype.hasOwnProperty.call(body, key)) cfg[key] = body[key];
    }
    if (!['today', 'tomorrow'].includes(cfg.dateMode) || !['now', 'custom'].includes(cfg.timeMode)
        || typeof cfg.verifyOnly !== 'boolean' || !Number.isFinite(Number(cfg.interval))
        || Number(cfg.interval) < 1 || Number(cfg.interval) > 120) {
      return sendJson(res, { ok: false, message: '请检查日期、查询方式和轮询间隔（1–120 秒）' });
    }
    if (cfg.timeMode === 'custom' && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.startTime)
        || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.endTime) || cfg.startTime >= cfg.endTime)) {
      return sendJson(res, { ok: false, message: '请设置有效时段，结束时间必须晚于开始时间' });
    }
    if (!cfg.token && cfg.autoRefresh === false) return sendJson(res, { ok: false, message: '请先填写并校验 token' });
    if (!cfg.verifyOnly && cfg.timeMode === 'custom') {
      const invalid = validateBookingWindow(cfg, targetDate(cfg), effectiveWindow(cfg, 'book'));
      if (invalid) return sendJson(res, { ok: false, message: invalid });
    }
    if (renewal.job?.active && (cfg.verifyOnly || cfg.dateMode !== 'today')) return sendJson(res, { ok: false, message: '等待接管的定时重约计划需要今天的实际预约，请关闭观察模式或停止计划' });
    saveConfig(cfg);
    state.logs = [];
    engineLoop(cfg).catch(e => {
      state.running = false;
      log('任务异常停止：' + e.message, 'error');
    });
    return sendJson(res, { ok: true });
  }

  if (p === '/api/stop' && req.method === 'POST') {
    state.stopFlag = true;
    try { seatWatch.stop(); renewal.stop(); } catch (e) { return sendJson(res, { ok: false, message: e.message }); }
    return sendJson(res, { ok: true });
  }

  // ---- 状态 / 日志 ----
  if (p === '/api/status' && req.method === 'GET') {
    if (state.success || bookingStore.data.pendingAction) management.refresh().catch(() => {});
    return sendJson(res, {
      running: state.running,
      success: state.success,
      lastCheck: state.lastCheck,
      areas: state.lastAreas,
      orderResult: state.orderResult,
      lastFailure: state.lastFailure,
      booking: state.booking,
      bookingManagement: management.status(),
      pendingBooking: state.pendingBooking,
      checkingBooking: state.checkingBooking,
      bookingMessage: state.bookingMessage,
      storageError: state.storageError,
      stopReason: state.stopReason || '',
      renewal: renewal.status(),
      seatWatch: seatWatch.status(),
      logs: state.logs.slice(-200)
    });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

/* ============================================================
 * 八、启动时校验 + 后台看门狗（token 无感续期）
 * ============================================================ */
(async () => {
  const cfg = loadConfig();
  if (!cfg.token) { log('尚未保存登录态，请在界面点「一键获取登录态」完成首次登录。'); return; }
  const ok = await tokenValid(cfg);
  if (ok === true) {
    log('登录态有效。token 过期后会自动静默续期，无需手动操作。');
  } else if (ok === false && cfg.autoRefresh !== false) {
    log('检测到 token 已过期，正在自动续期...', 'warn');
    await runLoginFlow({ headlessFirst: true, allowHeaded: false });
  }
})();

// 每 15 分钟检查一次登录态（空闲时才检查），过期即静默续期
const WATCHDOG_MS = 15 * 60 * 1000;
setInterval(async () => {
  try {
    if (state.running || loginState.active) return;
    const cfg = loadConfig();
    if (!cfg.token || cfg.autoRefresh === false) return;
    const ok = await tokenValid(cfg);
    if (ok === false) {
      log('看门狗：token 已过期，自动续期...', 'warn');
      const r = await runLoginFlow({ headlessFirst: true, allowHeaded: false });
      if (!r.ok) log('看门狗：自动续期失败，下次将弹窗请求人工登录。可在界面点「一键获取登录态」。', 'error');
    }
  } catch (e) { /* 忽略，下轮再查 */ }
}, WATCHDOG_MS);

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  中南大学图书馆座位预约助手');
  console.log('  ----------------------------------------');
  console.log('  界面地址: http://127.0.0.1:' + PORT);
  console.log('  按 Ctrl+C 退出');
  console.log('');
  if (state.pendingBooking) reconcileBooking();
});
