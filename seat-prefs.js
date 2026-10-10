/**
 * 心仪座位候选排序（独立模块，便于单测）
 */
'use strict';
const areaPrefs = require('./public/area-seat-prefs.js');

/** 规范化心仪座位列表：去空、大写、去重、保持用户填写的优先级顺序 */
function normalizePrefs(list) {
  const out = [];
  const seen = new Set();
  (list || []).forEach(x => {
    const v = String(x == null ? '' : x).trim().toUpperCase();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  });
  return out;
}

/**
 * 生成候选座位顺序
 * @param {object} cfg        含 seatPrefs / seatPrefMode
 * @param {Array}  freeSeats  当前空闲座位（接口原顺序）
 * @returns {Array<{seat, pref, priority}>} 按尝试优先级排序
 *   - 心仪座位排前，顺序 = 用户填写的顺序
 *   - seatPrefMode='only'：只返回心仪座位（可能为空数组 → 调用方继续等待）
 *   - seatPrefMode='prefer'：心仪座位之后跟上其它空闲座位
 *   - 未设置心仪座位：返回全部空闲座位（不改变接口顺序）
 */
function orderCandidates(cfg, freeSeats) {
  const seats = freeSeats || [];
  const prefs = normalizePrefs(cfg && cfg.seatPrefs);

  if (!prefs.length) return seats.map(s => ({ seat: s, pref: false, priority: 0 }));

  const byNo = new Map();
  seats.forEach(s => byNo.set(String(s.no).trim().toUpperCase(), s));

  const out = [];
  const used = new Set();
  prefs.forEach((no, idx) => {
    const s = byNo.get(no);
    if (s) {
      out.push({ seat: s, pref: true, priority: idx + 1 });
      used.add(no);
    }
  });

  if (!cfg || cfg.seatPrefMode !== 'only') {
    seats.forEach(s => {
      const no = String(s.no).trim().toUpperCase();
      if (!used.has(no)) out.push({ seat: s, pref: false, priority: 0 });
    });
  }
  return out;
}

/** 心仪座位里当前可约的（按优先级） */
function prefHits(cfg, freeSeats) {
  return orderCandidates(Object.assign({}, cfg, { seatPrefMode: 'only' }), freeSeats);
}

function areaPreference(cfg, areaId) {
  return areaPrefs.normalize(cfg.areaSeatPrefs?.[String(areaId)]);
}

function orderAreaCandidates(cfg, areaId, freeSeats) {
  const pref = areaPreference(cfg, areaId);
  // New per-area preferences always fall back inside the same supplied seat list.
  if (cfg.areaSeatPrefs !== undefined || cfg.preferAreas?.length) {
    return orderCandidates({ seatPrefs: pref.mode === 'prefer' ? pref.seats : [], seatPrefMode: 'prefer' }, freeSeats);
  }
  return orderCandidates(cfg, freeSeats);
}

module.exports = { normalizePrefs, orderCandidates, prefHits, areaPreference, orderAreaCandidates };
