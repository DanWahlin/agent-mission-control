/* ============================================================
   Copilot Mission Control — landing page interactions
   Starfield + particles + screenshot carousel + scroll reveal
   ============================================================ */

(function () {
  'use strict';

  // ---------- Starfield (night sky) ----------
  const canvas = document.getElementById('starfield');
  const ctx = canvas.getContext('2d');
  let stars = [];
  const STAR_COUNT = 110;
  // Slightly warmer palette than a pure space site — leans into the
  // golden lantern / royal purple vibe of the mission theme.
  const COLORS = ['#ffffff', '#c8c8ff', '#ffe8a8', '#a8d8ff', '#e0c8ff'];

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function createStars() {
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.6 + 0.3,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: Math.random() * 0.02 + 0.005,
      });
    }
  }

  function drawStars(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      const alpha = 0.4 + 0.6 * Math.abs(Math.sin(s.phase + t * s.twinkleSpeed));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.globalAlpha = alpha;
      ctx.fill();
      if (s.r > 1) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.globalAlpha = alpha * 0.07;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------- Floating particles (gold embers + purple sparks) ----------
  const particleContainer = document.getElementById('particles');
  const PARTICLE_COUNT = 8;

  function createParticles() {
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const el = document.createElement('div');
      const size = Math.random() * 3 + 1;
      const isGold = Math.random() > 0.55;
      el.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        background: ${isGold ? 'rgba(255,198,41,0.4)' : 'rgba(155,109,255,0.35)'};
        left: ${Math.random() * 100}%;
        top: ${Math.random() * 100}%;
        animation: particleFloat ${8 + Math.random() * 12}s ease-in-out infinite;
        animation-delay: ${-Math.random() * 10}s;
        pointer-events: none;
        filter: blur(${Math.random() > 0.5 ? 1 : 0}px);
      `;
      particleContainer.appendChild(el);
    }
  }

  const styleSheet = document.createElement('style');
  styleSheet.textContent = `
    @keyframes particleFloat {
      0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.3; }
      25% { transform: translate(${rand(-40, 40)}px, ${rand(-60, 60)}px) scale(1.3); opacity: 0.6; }
      50% { transform: translate(${rand(-30, 30)}px, ${rand(-80, 20)}px) scale(0.8); opacity: 0.4; }
      75% { transform: translate(${rand(-50, 50)}px, ${rand(-40, 40)}px) scale(1.1); opacity: 0.5; }
    }
  `;
  document.head.appendChild(styleSheet);

  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // ---------- Scroll reveal ----------
  function revealSections() {
    const sections = document.querySelectorAll('.section');
    const windowH = window.innerHeight;
    for (const sec of sections) {
      const rect = sec.getBoundingClientRect();
      if (rect.top < windowH * 0.85) {
        sec.classList.add('visible');
      }
    }
  }

  // ---------- Occasional shooting stars ----------
  let lastShootingStar = 0;
  function maybeShootingStar(t) {
    if (t - lastShootingStar < 4000 || Math.random() > 0.002) return;
    lastShootingStar = t;
    const startX = Math.random() * canvas.width * 0.8;
    const startY = Math.random() * canvas.height * 0.4;
    const length = 60 + Math.random() * 80;
    const angle = Math.PI / 5 + Math.random() * 0.4;
    const endX = startX + Math.cos(angle) * length;
    const endY = startY + Math.sin(angle) * length;
    const grad = ctx.createLinearGradient(startX, startY, endX, endY);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.8)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // ---------- Screenshot carousel ----------
  // Each shot rotates through the showcase frame in the hero. Durations
  // are deliberately long because screenshots aren't animated GIFs —
  // a viewer needs time to read the dashboard.
  const SHOTS = [
    { src: 'img/dashboard.png',           label: '🏰 Full dashboard',          duration: 7000 },
    { src: 'img/focus-mode.png',          label: '👁 Focus mode',              duration: 6000 },
    { src: 'img/dashboard-wide.png',      label: '🖥 Wide layout',             duration: 7000 },
    { src: 'img/focus-mode-compact.png',  label: '📐 Focus mode · compact',    duration: 6000 },
  ];

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function initCarousel() {
    const display = document.getElementById('gif-display');
    const label = document.getElementById('gif-label');
    const indicatorWrap = document.getElementById('gif-indicators');
    if (!display || !label || !indicatorWrap) return;

    const order = shuffle([...Array(SHOTS.length).keys()]);
    let currentIdx = 0;

    order.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.className = 'gif-dot' + (i === 0 ? ' active' : '');
      dot.addEventListener('click', () => goTo(i));
      indicatorWrap.appendChild(dot);
    });

    const toolbar = document.querySelector('.gif-toolbar');
    const progressBar = document.createElement('div');
    progressBar.className = 'gif-progress';
    toolbar.parentNode.insertBefore(progressBar, toolbar.nextSibling);

    const FADE_MS = 350;
    let timer = null;

    function showShot(idx) {
      currentIdx = idx;
      const data = SHOTS[order[idx]];
      const dur = data.duration;

      display.classList.remove('visible');
      label.style.opacity = '0';
      progressBar.style.transition = 'none';
      progressBar.style.width = '0%';

      setTimeout(() => {
        display.src = data.src;
        label.textContent = data.label;

        const onLoad = () => {
          display.removeEventListener('load', onLoad);
          display.classList.add('visible');
          label.style.opacity = '1';
          requestAnimationFrame(() => {
            progressBar.style.transition = `width ${dur}ms linear`;
            progressBar.style.width = '100%';
          });
        };

        display.addEventListener('load', onLoad);
        if (display.complete && display.naturalWidth > 0) {
          display.removeEventListener('load', onLoad);
          onLoad();
        }

        indicatorWrap.querySelectorAll('.gif-dot').forEach((d, i) => {
          d.classList.toggle('active', i === idx);
        });

        clearTimeout(timer);
        timer = setTimeout(next, dur + FADE_MS);
      }, FADE_MS);
    }

    function next() { showShot((currentIdx + 1) % order.length); }
    function goTo(idx) { clearTimeout(timer); showShot(idx); }

    showShot(0);

    // Lightbox
    const lightbox = document.getElementById('lightbox');
    const lbImg = document.getElementById('lightbox-img');
    const lbLabel = document.getElementById('lightbox-label');

    display.addEventListener('click', () => {
      const data = SHOTS[order[currentIdx]];
      lbImg.src = data.src;
      lbLabel.textContent = data.label;
      lightbox.classList.add('open');
      clearTimeout(timer);
    });

    function closeLightbox() {
      lightbox.classList.remove('open');
      lbImg.src = '';
      showShot(currentIdx);
    }

    document.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox.classList.contains('open')) closeLightbox();
    });
  }

  initCarousel();

  // ---------- Main loop ----------
  function loop(t) {
    drawStars(t);
    maybeShootingStar(t);
    requestAnimationFrame(loop);
  }

  // ---------- Init ----------
  resize();
  createStars();
  createParticles();
  revealSections();

  window.addEventListener('resize', () => { resize(); createStars(); });
  window.addEventListener('scroll', revealSections, { passive: true });

  // Navbar toggle (mobile)
  const navToggle = document.getElementById('navbar-toggle');
  const navLinks = document.getElementById('navbar-links');
  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      navToggle.classList.toggle('open');
      navLinks.classList.toggle('open');
    });
    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        navToggle.classList.remove('open');
        navLinks.classList.remove('open');
      });
    });
  }

  // Active section highlight on scroll
  const sections = document.querySelectorAll('.section[id]');
  const navItems = document.querySelectorAll('.navbar-links li a[href^="#"]');
  function updateActiveNav() {
    let current = '';
    for (const sec of sections) {
      const rect = sec.getBoundingClientRect();
      if (rect.top <= 120) current = sec.id;
    }
    navItems.forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === '#' + current);
    });
  }
  window.addEventListener('scroll', updateActiveNav, { passive: true });

  requestAnimationFrame(loop);
})();
