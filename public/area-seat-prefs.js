(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AreaSeatPrefs = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function normalize(raw) {
    if (raw == null) return { mode: 'any', seats: [] };
    if (!raw || !['any', 'prefer'].includes(raw.mode)) throw Error('座位偏好模式无效');
    if (raw.mode === 'any') return { mode: 'any', seats: [] };
    if (!Array.isArray(raw.seats) || raw.seats.length > 2000) throw Error('座位偏好列表无效或过长');
    const seats = [...new Set(raw.seats.map(no => {
      if (typeof no !== 'string' || !no.trim() || no.length > 64) throw Error('座位编号无效');
      return no.trim().toUpperCase();
    }))];
    if (!seats.length) throw Error('请至少选择一个优先座位，或改为不限座位');
    return { mode: 'prefer', seats };
  }
  function normalizeMap(raw) {
    if (raw == null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 300) throw Error('区域座位偏好无效');
    return Object.fromEntries(Object.entries(raw).map(([id, value]) => {
      if (!/^[\w-]{1,64}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw Error('区域编号无效');
      return [id, normalize(value)];
    }));
  }
  function snapshot(ids, map) {
    const prefs = normalizeMap(map);
    return Object.fromEntries((ids || []).map(String).filter(id => Object.hasOwn(prefs, id)).map(id => [id, prefs[id]]));
  }
  function summary(raw) {
    const pref = normalize(raw);
    return pref.mode === 'prefer' ? '优先 ' + pref.seats.length + ' 个座位 · 无空位时选本区其他座位' : '不限座位';
  }
  // Resolve numbers/ranges against actual seats from this area only. Short numeric
  // labels may not be unique; require the full label instead of choosing arbitrarily.
  function parse(text, available) {
    const names = [...new Set((available || []).map(s => String(typeof s === 'string' ? s : s.no).trim().toUpperCase()))];
    const split = no => no.match(/^(.*?)(\d+)$/);
    const resolve = token => {
      const hits = /^\d+$/.test(token)
        ? names.filter(no => { const m = split(no); return m && Number(m[2]) === Number(token); })
        : names.filter(no => no === token);
      if (!hits.length) throw Error('本区域没有座位 ' + token);
      if (hits.length > 1) throw Error('编号 ' + token + ' 对应多个座位，请填写完整编号');
      return hits[0];
    };
    const result = [];
    const input = String(text || '').trim().toUpperCase().replace(/[–—~～至]/g, '-').replace(/\s*-\s*/g, '-');
    if (!input) throw Error('请输入座位编号或范围，例如 149, 150, 160-170');
    for (const token of input.split(/[\s,，、;；]+/).filter(Boolean)) {
      if (names.includes(token)) { result.push(token); continue; }
      const range = token.match(/^([A-Z0-9]*\d)-([A-Z0-9]*\d)$/);
      if (!range) { result.push(resolve(token)); continue; }
      const first = resolve(range[1]), last = resolve(range[2]);
      const start = split(first), end = split(last);
      if (!start || !end || start[1] !== end[1] || Number(start[2]) > Number(end[2])) throw Error('范围 ' + token + ' 无效，请使用同一组从小到大的编号');
      result.push(...names.filter(no => { const m = split(no); return m && m[1] === start[1] && Number(m[2]) >= Number(start[2]) && Number(m[2]) <= Number(end[2]); }));
    }
    return [...new Set(result)];
  }
  return { normalize, normalizeMap, snapshot, summary, parse };
});
