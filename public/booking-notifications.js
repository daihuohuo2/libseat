(function(root, factory){
  if(typeof module === 'object' && module.exports) module.exports = factory();
  else root.BookingNotifications = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  function message(b){
    return '座位：' + b.seat + '\n区域：' + b.area + '\n时间：' + b.date + ' ' + b.startTime + '–' + b.endTime;
  }
  function createTracker(onSuccess, storage){
    const seen = new Set();
    return function(status){
      const b = status && status.booking;
      if(!status || !status.success || !b || !b.id || !b.seat) return false;
      const key = 'libseat-booking-' + b.id;
      if(seen.has(b.id)) return false;
      try { if(storage && storage.getItem(key)) { seen.add(b.id); return false; } } catch(e) {}
      onSuccess(b);
      seen.add(b.id);
      try { if(storage) storage.setItem(key, '1'); } catch(e) {}
      return true;
    };
  }
  return { message: message, createTracker: createTracker };
});
