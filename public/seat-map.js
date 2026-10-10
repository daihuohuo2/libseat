/* Normalize the school's hand-positioned rectangles without changing seat identity. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SeatMap = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const statuses = {
    '1': { name: '空闲', className: 'available' },
    '2': { name: '已预约', className: 'reserved' },
    '7': { name: '临时离开', className: 'away' },
    '6': { name: '使用中', className: 'occupied' }
  };
  const unknown = { name: '未知状态', className: 'unknown' };
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  function alignAxis(items, axis, tolerance) {
    const groups = [];
    for (const item of [...items].sort((a, b) => a[axis] - b[axis] || a.index - b.index)) {
      let group = groups[groups.length - 1];
      // Never merge two seats into the same cell, even with malformed source coordinates.
      const collision = axis === 'cy' && group && group.columns.has(item.column);
      if (!group || item[axis] - median(group.values) > tolerance || collision) {
        group = { values: [], items: [], columns: new Set() };
        groups.push(group);
      }
      group.values.push(item[axis]);
      group.items.push(item);
      group.columns.add(item.column);
      if (axis === 'cx') item.column = groups.length - 1;
    }
    const centers = groups.map(group => median(group.values));
    const distances = centers.slice(1).map((value, i) => value - centers[i]).filter(value => value > tolerance);
    const pitch = distances.length ? median(distances) : 1;
    let cell = 0;
    groups.forEach((group, i) => {
      // Wider gaps remain empty grid cells, retaining the original aisles and banks.
      if (i) cell += Math.max(1, Math.round((centers[i] - centers[i - 1]) / pitch));
      group.items.forEach(item => { item[axis === 'cx' ? 'col' : 'row'] = cell; });
    });
  }

  function layout(seats) {
    const items = (seats || []).map((seat, index) => ({ seat, index,
      x: Number(seat.x), y: Number(seat.y), w: Number(seat.w), h: Number(seat.h)
    })).filter(item => Number.isFinite(item.x) && Number.isFinite(item.y)
      && Number.isFinite(item.w) && Number.isFinite(item.h) && item.w > 0 && item.h > 0);
    if (!items.length) return { seats: [], width: 0, height: 0, seatWidth: 32, seatHeight: 28 };
    items.forEach(item => { item.cx = item.x + item.w / 2; item.cy = item.y + item.h / 2; });
    alignAxis(items, 'cx', median(items.map(item => item.w)) * 0.65);
    alignAxis(items, 'cy', median(items.map(item => item.h)) * 0.65);
    const placed = items.map(item => ({ seat: item.seat, column: item.col, row: item.row,
      x: item.col * 38, y: item.row * 34 }));
    return { seats: placed, width: Math.max(...placed.map(item => item.x)) + 32,
      height: Math.max(...placed.map(item => item.y)) + 28, seatWidth: 32, seatHeight: 28 };
  }

  function label(no) {
    const value = String(no == null ? '' : no);
    return value.match(/\d+$/)?.[0] || value;
  }
  function isMine(seat, map, snapshot) {
    const b = snapshot?.booking;
    if (!snapshot?.success || !b || snapshot.pendingBooking || snapshot.bookingManagement?.pendingAction
      || ['cancelled', 'completed'].includes(b.remoteState) || map.date !== b.date) return false;
    if (b.areaId != null && String(b.areaId) !== String(map.area?.id)) return false;
    if (b.seatId != null && seat.id != null) return String(b.seatId) === String(seat.id);
    return String(seat.no) === String(b.seat) && (b.areaId != null || map.area?.name === b.area);
  }
  return { layout, label, isMine, status: code => statuses[String(code)] || unknown, statusOrder: ['1', '2', '7', '6'] };
});
