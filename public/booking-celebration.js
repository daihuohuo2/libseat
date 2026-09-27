(function () {
  'use strict';
  const active = new WeakMap();
  function stop(dialog) {
    const cleanup = active.get(dialog);
    if (cleanup) cleanup();
  }
  function play(dialog) {
    stop(dialog);
    if (!dialog.open || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const layer = dialog.querySelector('.booking-burst');
    const colors = ['#346652', '#e5ae45', '#e78469', '#74aaa0', '#b49acf'];
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 64; i++) {
      const particle = document.createElement('i');
      const angle = (i / 64) * Math.PI * 2;
      const radius = Math.min(innerWidth, innerHeight) * (0.3 + Math.random() * 0.28);
      particle.className = 'booking-particle';
      particle.style.setProperty('--x', Math.cos(angle) * radius + 'px');
      particle.style.setProperty('--y', Math.sin(angle) * radius + 'px');
      particle.style.setProperty('--fall', (100 + Math.random() * 130) + 'px');
      particle.style.setProperty('--turn', (180 + Math.random() * 540) + 'deg');
      particle.style.setProperty('--delay', Math.random() * 100 + 'ms');
      particle.style.background = colors[i % colors.length];
      if (i % 3 === 0) particle.style.borderRadius = '50%';
      fragment.appendChild(particle);
    }
    const ring = document.createElement('i');
    ring.className = 'booking-shockwave';
    fragment.appendChild(ring);
    layer.replaceChildren(fragment);
    dialog.classList.add('booking-celebrating');
    const cleanup = () => {
      clearTimeout(timer);
      dialog.classList.remove('booking-celebrating');
      layer.replaceChildren();
      dialog.removeEventListener('close', cleanup);
      active.delete(dialog);
    };
    const timer = setTimeout(cleanup, 2400);
    active.set(dialog, cleanup);
    dialog.addEventListener('close', cleanup, { once: true });
  }
  window.BookingCelebration = { play, stop };
})();
