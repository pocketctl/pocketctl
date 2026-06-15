/* ============================================
   pocketctl — 侧栏折叠/展开
   自包含：自动注入折叠按钮到 sidebar 底部
   依赖：css/web-shared.css 里的 .sidebar-collapsed / .sidebar-toggle-btn
   ============================================ */
(function () {
  'use strict';
  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  var ICON_COLLAPSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 19l-7-7 7-7"/><path d="M18 19l-7-7 7-7"/></svg>';
  var ICON_EXPAND   = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 5l7 7-7 7"/><path d="M6 5l7 7-7 7"/></svg>';

  var btn = document.createElement('button');
  btn.className = 'sidebar-toggle-btn';
  btn.type = 'button';
  btn.title = '折叠侧栏';
  btn.setAttribute('aria-label', '折叠侧栏');

  // 插入到 sidebar-footer 上方（若不存在则 append）
  var footer = sidebar.querySelector('.sidebar-footer');
  if (footer) {
    sidebar.insertBefore(btn, footer);
  } else {
    sidebar.appendChild(btn);
  }

  // 读取本地偏好
  var saved = localStorage.getItem('pocketctl-sidebar');
  if (saved === 'collapsed') {
    document.documentElement.classList.add('sidebar-collapsed');
  }

  function updateIcon() {
    var collapsed = document.documentElement.classList.contains('sidebar-collapsed');
    btn.innerHTML = collapsed ? ICON_EXPAND : ICON_COLLAPSE;
    btn.title = collapsed ? '展开侧栏' : '折叠侧栏';
    btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '折叠侧栏');
  }
  updateIcon();

  btn.addEventListener('click', function () {
    var collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
    localStorage.setItem('pocketctl-sidebar', collapsed ? 'collapsed' : 'expanded');
    updateIcon();
  });
})();
