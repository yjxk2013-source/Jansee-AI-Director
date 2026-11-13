(() => {
  'use strict';
  const endpoint = '/api/v1/analytics/collect';
  const storageKey = 'jansee.analytics.visitor.v1';
  const optOutKey = 'jansee.analytics.optout.v1';

  // 1. 管理员自测免统计通道
  window.disableJanseeAnalytics = () => {
    try {
      localStorage.setItem(optOutKey, '1');
      localStorage.removeItem(storageKey);
    } catch (_) { }
  };
  window.enableJanseeAnalytics = () => {
    try {
      localStorage.removeItem(optOutKey);
    } catch (_) { }
    location.reload();
  };

  try {
    if (localStorage.getItem(optOutKey) === '1') return;
    if (localStorage.getItem('jansee.admin.token')) {
      localStorage.setItem(optOutKey, '1');
      localStorage.removeItem(storageKey);
      return;
    }
    if (location.pathname.startsWith('/admin')) {
      localStorage.setItem(optOutKey, '1');
      return;
    }
  } catch (_) {
    return;
  }

  // 2. 自动化工具与无头浏览器底层指纹硬伤拦截
  try {
    if (navigator.webdriver) return;
    if (!window.screen || window.screen.width < 100 || window.screen.height < 100) return;
    if (window.outerWidth === 0 && window.outerHeight === 0 && window.innerWidth === 0) return;
    if (!navigator.languages || navigator.languages.length === 0) return;
  } catch (_) {
    return;
  }

  function visitorId() {
    try {
      let id = localStorage.getItem(storageKey);
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : 'jx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
        localStorage.setItem(storageKey, id);
      }
      return id;
    } catch (_) {
      return 'jx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
  }

  const id = visitorId();
  const sp = new URLSearchParams(location.search);
  const utmSource = sp.get('utm_source') || sp.get('channel') || sp.get('ref') || sp.get('from') || '';

  // 记录初次触达渠道与第一跳 Referrer（供后续注册转化归因）
  try {
    if (utmSource && !localStorage.getItem('jansee.channel')) {
      localStorage.setItem('jansee.channel', utmSource);
    }
    if (document.referrer && !/jansee\./.test(document.referrer) && !localStorage.getItem('jansee.referrer')) {
      localStorage.setItem('jansee.referrer', document.referrer);
    }
  } catch (_) { }

  const startTime = Date.now();
  let pageviewSent = false;

  function send(event, trigger = 'direct') {
    if (document.visibilityState === 'hidden' && event === 'heartbeat') return;
    const dwellMs = Math.max(0, Date.now() - startTime);
    const payload = JSON.stringify({
      visitorId: id,
      event,
      path: location.pathname,
      referrer: document.referrer || '',
      utmSource,
      verifiedBy: trigger,
      dwellMs
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([payload], { type: 'application/json' }));
      } else {
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
          credentials: 'same-origin'
        }).catch(() => { });
      }
    } catch (_) { }
  }

  // 3. 真人交互门禁（Human Interaction Proof）
  // 爬虫与无头渲染机在 0 秒内执行完 JS 即销毁容器，绝不会产生人类物理交互或在前台专注驻留。
  function onHumanEngaged(trigger) {
    if (pageviewSent) return;
    pageviewSent = true;
    cleanupListeners();
    send('pageview', trigger);
  }

  let lastX = -1;
  let lastY = -1;
  function onMouseMove(e) {
    if (lastX === -1) {
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    // 排除合成的 (0,0) 或伪造事件，必须有真实物理位移
    const delta = Math.hypot(e.clientX - lastX, e.clientY - lastY);
    if (delta > 8) {
      onHumanEngaged('mousemove');
    }
  }

  function onScroll() {
    if (window.scrollY > 15 || window.scrollX > 15) {
      onHumanEngaged('scroll');
    }
  }

  function onTouch() {
    onHumanEngaged('touch');
  }

  function onClick() {
    onHumanEngaged('click');
  }

  function onKeyDown() {
    onHumanEngaged('keydown');
  }

  // 专注阅读驻留保底：用户打开网页若认真阅读首屏内容未滑动，前台可见驻留满 4 秒也视为真人
  const dwellTimer = setTimeout(() => {
    if (!pageviewSent && document.visibilityState === 'visible') {
      onHumanEngaged('dwell_4s');
    }
  }, 4000);

  function cleanupListeners() {
    clearTimeout(dwellTimer);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('touchstart', onTouch);
    window.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKeyDown);
  }

  window.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('touchstart', onTouch, { passive: true });
  window.addEventListener('click', onClick, { passive: true });
  window.addEventListener('keydown', onKeyDown, { passive: true });

  // 4. 有效驻留心跳（必须在已完成真人交互认定的前提下）
  window.setInterval(() => {
    if (pageviewSent && document.visibilityState === 'visible') {
      send('heartbeat', 'interval');
    }
  }, 60000);
})();
