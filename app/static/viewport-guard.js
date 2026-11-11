(function () {
  'use strict';

  var LOCKED_META =
    'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
  var UNLOCK_PULSE_META =
    'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0001, user-scalable=no, viewport-fit=cover';

  var isResetting = false;
  var followUpTimer = null;
  var resizeCallbacks = [];

  function isChartTarget(target) {
    return Boolean(target && target.closest && target.closest('.chart-canvas-view, .pane-chart-wrap'));
  }

  function isInputTarget(target) {
    if (!target || !target.tagName) return false;
    var tag = target.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  function resetViewportZoomTo100(force) {
    if (isResetting) return false;
    var vv = window.visualViewport;
    var scale = (vv && Number(vv.scale)) || 1;
    var zoomed = Math.abs(scale - 1) > 0.015;
    var isFixedTerminal = Boolean(document.body && document.body.classList.contains('ex-theme-dark'));
    var horizDrifted = Math.abs(window.scrollX || document.documentElement.scrollLeft || 0) > 2;
    var vertDrifted = isFixedTerminal && Math.abs(window.scrollY || document.documentElement.scrollTop || 0) > 2;

    if (!force && !zoomed && !horizDrifted && !vertDrifted) {
      return false;
    }

    isResetting = true;
    try {
      var meta = document.querySelector('meta[name="viewport"]');
      if (meta) {
        if (force || zoomed) {
          meta.setAttribute('content', UNLOCK_PULSE_META);
          void document.documentElement.offsetWidth;
        }
        meta.setAttribute('content', LOCKED_META);
      }

      if (document.documentElement) {
        document.documentElement.scrollLeft = 0;
        if (isFixedTerminal) document.documentElement.scrollTop = 0;
      }
      if (document.body) {
        document.body.scrollLeft = 0;
        if (isFixedTerminal) document.body.scrollTop = 0;
      }
      window.scrollTo(0, isFixedTerminal ? 0 : window.scrollY);

      resizeCallbacks.forEach(function (cb) {
        try {
          cb();
        } catch (_) {}
      });
    } finally {
      window.requestAnimationFrame(function () {
        isResetting = false;
      });
    }

    if (followUpTimer) clearTimeout(followUpTimer);
    followUpTimer = setTimeout(function () {
      var vvNow = window.visualViewport;
      if (vvNow && Math.abs((Number(vvNow.scale) || 1) - 1) > 0.02) {
        resetViewportZoomTo100(true);
      } else {
        resizeCallbacks.forEach(function (cb) {
          try {
            cb();
          } catch (_) {}
        });
      }
    }, 120);

    return true;
  }

  window.resetViewportZoomTo100 = resetViewportZoomTo100;
  window.registerViewportResizeCallback = function (cb) {
    if (typeof cb === 'function' && resizeCallbacks.indexOf(cb) === -1) {
      resizeCallbacks.push(cb);
    }
  };

  // Block iOS Safari native page-pinch gesture events while leaving JS chart handlers active
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (evt) {
    document.addEventListener(
      evt,
      function (e) {
        if (e.cancelable) e.preventDefault();
        if (evt === 'gestureend') resetViewportZoomTo100(false);
      },
      { passive: false }
    );
  });

  // Bubble-phase multi-touch prevention: child Lightweight Charts handlers receive 2-finger pinch first,
  // while browser native whole-page pinch-zoom is prevented on touchstart and touchmove everywhere.
  document.addEventListener(
    'touchstart',
    function (e) {
      if (e.touches && e.touches.length > 1 && e.cancelable) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  document.addEventListener(
    'touchmove',
    function (e) {
      if (e.touches && e.touches.length > 1 && e.cancelable) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  document.addEventListener(
    'touchend',
    function (e) {
      if (!e.touches || e.touches.length === 0) {
        setTimeout(function () {
          resetViewportZoomTo100(false);
        }, 60);
      }
    },
    { passive: true }
  );

  // Block double-tap/dblclick page zoom outside text fields and chart canvases
  document.addEventListener(
    'dblclick',
    function (e) {
      if (!isInputTarget(e.target) && !isChartTarget(e.target) && e.cancelable) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  // Block desktop Ctrl/Cmd + wheel browser zoom outside the chart container (Lightweight Charts handles wheel inside)
  window.addEventListener(
    'wheel',
    function (e) {
      if ((e.ctrlKey || e.metaKey) && !isChartTarget(e.target) && e.cancelable) {
        e.preventDefault();
      }
    },
    { passive: false }
  );

  // Recover automatically if any browser action or keyboard focus temporarily zoomed the viewport
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function () {
      resetViewportZoomTo100(false);
    });
    window.visualViewport.addEventListener('scroll', function () {
      resetViewportZoomTo100(false);
    });
  }

  window.addEventListener('orientationchange', function () {
    setTimeout(function () {
      resetViewportZoomTo100(true);
    }, 150);
  });

  document.addEventListener(
    'focusout',
    function (e) {
      if (isInputTarget(e.target)) {
        setTimeout(function () {
          resetViewportZoomTo100(false);
        }, 120);
      }
    },
    true
  );
})();
