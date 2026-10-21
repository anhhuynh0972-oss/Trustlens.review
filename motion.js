// Landing-page motion: scroll reveals, sequenced workflow steps, count-up statistics, scroll progress,
// active-section nav and a subtle hero tilt. CSS does the animating; this file only toggles classes.
// Nothing runs when the visitor prefers reduced motion, and content stays visible if this file fails.
(function () {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const doc = document.documentElement;
  const header = document.querySelector('.site-header');
  const bar = document.getElementById('tl-progress');

  // ---- Scroll progress bar + solid header (cheap: one rAF per scroll burst) ----
  let ticking = false;
  function onScroll() {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const max = doc.scrollHeight - innerHeight;
      if (bar) bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
      if (header) header.classList.toggle('scrolled', scrollY > 8);
      markActive();
    });
  }

  // ---- Active section in the nav: the section crossing a line 40% down the viewport ----
  const links = new Map([...document.querySelectorAll('.nav a[data-go]')].map(a => [a.dataset.go, a]));
  const sections = [...links.keys()].map(id => document.getElementById(id)).filter(Boolean);
  let activeId = null;
  function markActive() {
    const line = innerHeight * 0.4;
    const landingVisible = !document.getElementById('landing').hidden;
    const hit = landingVisible ? sections.find(sec => { const r = sec.getBoundingClientRect(); return r.top <= line && r.bottom > line; }) : null;
    const id = hit ? hit.id : null;
    if (id === activeId) return;
    activeId = id;
    links.forEach((a, key) => { const on = key === id; a.classList.toggle('is-active', on); if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
  }

  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  onScroll();

  if (reduced || !('IntersectionObserver' in window)) return;
  doc.classList.add('motion');

  // ---- Scroll reveal (static landing content only; the dashboard re-renders and is excluded) ----
  const GROUPS = [
    '#landing .section-head', '.prob-grid > .feature', '.prob-users', '.rs-grid > .rs-card', '.map-table', '#research .research-note',
    '.rs-list', '.refs', '#how .step', '.stack-grid > .feature', '#stack-status', '.sv-grid > .sv-card', '.sv-notes',
    '.feature-grid > .feature', '#demo .demo-cta', '#demo-row', '.rm-grid > .rm-card', '.rm-status', '.ev2-grid > .feature',
    '.faq-list', '.cta-box', '.footer-grid > div', '.footer-sources'
  ];
  const targets = [];
  GROUPS.forEach(sel => document.querySelectorAll(sel).forEach(el => {
    if (el.closest('#dashboard') || el.classList.contains('rv')) return;
    // Stagger siblings in the same grid (capped so long lists do not lag).
    const sibs = [...el.parentElement.children].filter(c => c.matches(sel));
    const i = Math.max(0, sibs.indexOf(el));
    const step = el.matches('#how .step') ? 0.14 : 0.07;
    el.style.setProperty('--rv-d', +(Math.min(i, 6) * step).toFixed(2) + 's');
    el.classList.add('rv');
    targets.push(el);
  }));

  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      e.target.querySelectorAll('.ring span, .rs-stat').forEach(countUp);
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  targets.forEach(el => io.observe(el));

  // ---- Count-up for verified statistics; always ends on the exact original text ----
  function countUp(el) {
    if (el.dataset.counted) return;
    const original = el.textContent;
    const m = original.match(/^(\D*?)(\d*[.,]?\d+)(\D*)$/);
    if (!m) return;
    el.dataset.counted = '1';
    const [, pre, num, post] = m;
    const sep = num.includes(',') ? ',' : '.';
    const dec = (num.split(/[.,]/)[1] || '').length;
    const target = parseFloat(num.replace(',', '.'));
    const leadingDot = /^[.,]/.test(num);
    const ring = el.parentElement && el.parentElement.classList.contains('ring') ? el.parentElement : null;
    const ringTarget = ring ? parseFloat(ring.style.getPropertyValue('--p')) : null;
    const start = performance.now(), dur = 1400;
    const fmt = v => { let s = v.toFixed(dec); if (sep === ',') s = s.replace('.', ','); if (leadingDot) s = s.replace(/^0/, ''); return pre + s + post; };
    let done = false;
    const finish = () => { if (done) return; done = true; running.delete(finish); el.textContent = original; if (ring) ring.style.setProperty('--p', String(ringTarget)); };
    running.add(finish);
    setTimeout(finish, dur + 200); // backstop: animation frames pause in hidden tabs
    const tick = now => {
      if (done) return;
      const p = Math.min(1, (now - start) / dur), k = ease(p);
      if (p >= 1) return finish();
      el.textContent = fmt(target * k);
      if (ring) ring.style.setProperty('--p', (ringTarget * k).toFixed(1));
      requestAnimationFrame(tick);
    };
    el.textContent = fmt(0);
    if (ring) ring.style.setProperty('--p', '0');
    requestAnimationFrame(tick);
  }
  // Never leave an intermediate number on screen when the tab is hidden mid-animation.
  const running = new Set();
  document.addEventListener('visibilitychange', () => { if (document.hidden) [...running].forEach(f => f()); });
  function ease(p) { p = Math.max(0, Math.min(1, p)); return 1 - Math.pow(1 - p, 3); }

  // ---- Subtle tilt on the hero mockup (fine pointers only, max 4°) ----
  const mock = document.querySelector('.hero .mock');
  if (mock && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    const cards = mock.querySelectorAll('.mock-card');
    mock.addEventListener('pointermove', e => {
      const r = mock.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      cards.forEach((c, i) => { c.style.transform = `perspective(900px) rotateX(${(-y * 4).toFixed(2)}deg) rotateY(${(x * 4).toFixed(2)}deg) translateZ(${i * 6}px)`; });
    });
    mock.addEventListener('pointerleave', () => cards.forEach(c => { c.style.transform = ''; }));
  }

  window.TL_motion = { reveal: el => el.classList.add('in') };
})();
