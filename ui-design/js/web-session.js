/* ============================================
   pocketctl — 会话操作组件
   ⋯ 更多菜单：复制 ID / 固定 / 重命名 / 导出 / 删除
   自包含：自动创建所需 DOM，页面只需 PocketctlSession.attach()
   依赖：css/web-shared.css 里的 .ss-* 样式
   ============================================ */
(function () {
  'use strict';
  if (window.PocketctlSession) return;

  var ICONS = {
    more: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>',
    pin: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l3 3.2v2H6v-2l3-3.2z"/></svg>',
    edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
    trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>',
    warn: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>'
  };

  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    }
    return n;
  }

  var menuEl, dialogEl, exportEl, toastEl, toastTimer;
  var currentTarget = null, currentConfig = null;

  function ensureShell() {
    if (menuEl) return;

    // ---- ⋯ menu ----
    menuEl = el('div', { class: 'ss-menu', id: 'ss-menu' });
    menuEl.innerHTML =
      '<button class="ss-menu-item" data-act="copy">' + ICONS.copy + '<span>复制会话 ID</span><em class="ss-menu-hint"></em></button>' +
      '<div class="ss-menu-sep"></div>' +
      '<button class="ss-menu-item" data-act="pin">' + ICONS.pin + '<span class="ss-pin-label">固定到顶部</span></button>' +
      '<button class="ss-menu-item" data-act="rename">' + ICONS.edit + '<span>重命名会话</span></button>' +
      '<button class="ss-menu-item" data-act="export">' + ICONS.download + '<span>导出记录</span></button>' +
      '<div class="ss-menu-sep"></div>' +
      '<button class="ss-menu-item danger" data-act="delete">' + ICONS.trash + '<span>删除会话</span></button>';
    menuEl.addEventListener('click', onMenuClick);

    // ---- delete confirm dialog ----
    dialogEl = el('div', { class: 'ss-overlay', id: 'ss-overlay' });
    dialogEl.innerHTML =
      '<div class="ss-dialog">' +
        '<div class="ss-dialog-icon">' + ICONS.warn + '</div>' +
        '<h3 class="ss-dialog-title">删除会话？</h3>' +
        '<p class="ss-dialog-desc">将删除该会话及其所有消息和工具调用记录。删除后 5 秒内可撤销恢复。</p>' +
        '<div class="ss-dialog-target"></div>' +
        '<div class="ss-dialog-actions">' +
          '<button class="btn btn-secondary ss-cancel">取消</button>' +
          '<button class="btn ss-confirm">' +
            '<span class="ss-confirm-label">确认删除</span>' +
            '<span class="ss-confirm-loading"><span class="spinner"></span>删除中</span>' +
          '</button>' +
        '</div>' +
      '</div>';
    dialogEl.querySelector('.ss-cancel').addEventListener('click', closeDialog);
    dialogEl.querySelector('.ss-confirm').addEventListener('click', onConfirmDelete);
    dialogEl.addEventListener('click', function (e) { if (e.target === dialogEl) closeDialog(); });

    // ---- export dialog ----
    exportEl = el('div', { class: 'ss-overlay ss-export-overlay', id: 'ss-export-overlay' });
    exportEl.innerHTML =
      '<div class="ss-dialog ss-export-dialog">' +
        '<div class="ss-dialog-icon ss-export-icon">' + ICONS.download + '</div>' +
        '<h3 class="ss-dialog-title">导出会话记录</h3>' +
        '<p class="ss-dialog-desc">选择导出格式，文件将下载到本地。</p>' +
        '<div class="ss-dialog-target ss-export-target"></div>' +
        '<div class="ss-format-group">' +
          '<button class="ss-format selected" data-fmt="md"><span class="ss-format-name">Markdown</span><span class="ss-format-desc">.md · 适合阅读与分享</span></button>' +
          '<button class="ss-format" data-fmt="json"><span class="ss-format-name">JSON</span><span class="ss-format-desc">.json · 结构化原始数据</span></button>' +
          '<button class="ss-format" data-fmt="txt"><span class="ss-format-name">纯文本</span><span class="ss-format-desc">.txt · 仅消息正文</span></button>' +
        '</div>' +
        '<div class="ss-dialog-actions">' +
          '<button class="btn btn-secondary ss-export-cancel">取消</button>' +
          '<button class="btn ss-export-confirm">导出下载</button>' +
        '</div>' +
      '</div>';
    exportEl.querySelector('.ss-export-cancel').addEventListener('click', closeExportDialog);
    exportEl.querySelector('.ss-export-confirm').addEventListener('click', onConfirmExport);
    exportEl.querySelector('.ss-format-group').addEventListener('click', function (e) {
      var f = e.target.closest('.ss-format');
      if (!f) return;
      exportEl.querySelectorAll('.ss-format').forEach(function (x) { x.classList.remove('selected'); });
      f.classList.add('selected');
    });
    exportEl.addEventListener('click', function (e) { if (e.target === exportEl) closeExportDialog(); });

    // ---- toast ----
    toastEl = el('div', { class: 'ss-toast', id: 'ss-toast' });

    document.body.append(menuEl, dialogEl, exportEl, toastEl);

    // global dismiss
    document.addEventListener('click', function (e) {
      if (!menuEl.contains(e.target) && !e.target.closest('.ss-more-btn')) closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeMenu(); closeDialog(); closeExportDialog(); }
    });
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu, true);
  }

  function ensureId(item) {
    if (!item.dataset.id) {
      item.dataset.id = 'sess_' + Math.random().toString(36).slice(2, 10);
    }
    return item.dataset.id;
  }

  function attach(config) {
    ensureShell();
    if (!config._bound) {
      config._bound = true;
      config._observer = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            if (n.matches && n.matches(config.itemSelector)) injectMoreBtn(n, config);
            if (n.querySelectorAll) n.querySelectorAll(config.itemSelector).forEach(function (i) { injectMoreBtn(i, config); });
          });
        });
      });
      config._observer.observe(document.body, { childList: true, subtree: true });
    }
    document.querySelectorAll(config.itemSelector).forEach(function (item) { injectMoreBtn(item, config); });
  }

  function injectMoreBtn(item, config) {
    if (item.querySelector('.ss-more-btn')) return;
    ensureId(item);
    var btn = el('button', { class: 'ss-more-btn', type: 'button', title: '更多操作', html: ICONS.more });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      openMenu(item, btn, config);
    });
    var host = (config.actionsSelector && item.querySelector(config.actionsSelector)) || item;
    host.appendChild(btn);
  }

  function openMenu(item, btn, config) {
    currentTarget = item;
    currentConfig = config;
    var id = config.getId ? config.getId(item) : null;
    var copyItem = menuEl.querySelector('[data-act="copy"]');
    copyItem.style.display = id ? '' : 'none';
    copyItem.querySelector('.ss-menu-hint').textContent = id || '';
    // pin label reflects current state
    var pinned = isPinned(item);
    var pinItem = menuEl.querySelector('[data-act="pin"]');
    pinItem.querySelector('.ss-pin-label').textContent = pinned ? '取消固定' : '固定到顶部';
    pinItem.classList.toggle('active', pinned);

    menuEl.classList.add('open');
    var r = btn.getBoundingClientRect();
    var mw = menuEl.offsetWidth;
    var left = r.right - mw;
    if (left < 8) left = 8;
    if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    menuEl.style.left = left + 'px';
    menuEl.style.top = (r.bottom + 6) + 'px';
  }

  function closeMenu() { if (menuEl) menuEl.classList.remove('open'); }

  function isPinned(item) {
    return item.dataset.pinned === '1';
  }

  function onMenuClick(e) {
    var mi = e.target.closest('.ss-menu-item');
    if (!mi || !currentTarget) return;
    var act = mi.dataset.act;
    var item = currentTarget;
    var config = currentConfig;

    if (act === 'copy') {
      var id = config.getId(item);
      copyText(id);
      flashHint(mi, '已复制');
      setTimeout(closeMenu, 1200);
    } else if (act === 'pin') {
      closeMenu();
      var wasPinned = isPinned(item);
      applyPin(item, !wasPinned, config);
      showToast(!wasPinned ? '已固定到顶部' : '已取消固定', function () {
        applyPin(item, wasPinned, config);
      });
    } else if (act === 'rename') {
      closeMenu();
      openRenameEditor(item, config);
    } else if (act === 'export') {
      closeMenu();
      openExportDialog(item, config);
    } else if (act === 'delete') {
      closeMenu();
      openDialog(item, config);
    }
  }

  function copyText(t) {
    if (!t) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(function () {});
    }
  }

  function flashHint(mi, text) {
    var hint = mi.querySelector('.ss-menu-hint');
    var old = hint.textContent;
    hint.textContent = text;
    setTimeout(function () { if (hint.textContent === text) hint.textContent = old; }, 1400);
  }

  // ============ PIN ============
  function applyPin(item, pinned, config) {
    item.dataset.pinned = pinned ? '1' : '0';
    item.classList.toggle('pinned', pinned);
    var titleSel = config.titleSelector || '.session-title, .sl-title';
    var titleEl = item.querySelector(titleSel);
    if (titleEl) {
      var mark = titleEl.querySelector('.ss-pin-mark');
      if (pinned && !mark) {
        titleEl.insertBefore(el('span', { class: 'ss-pin-mark', html: ICONS.pin }), titleEl.firstChild);
      } else if (!pinned && mark) {
        mark.remove();
      }
    }
    // reorder: pinned → top of list; unpinned → after last pinned item
    var parent = item.parentNode;
    if (!parent) return;
    if (pinned) {
      var firstItem = parent.querySelector(config.itemSelector);
      if (firstItem && firstItem !== item) parent.insertBefore(item, firstItem);
    } else {
      var items = parent.querySelectorAll(config.itemSelector);
      var anchor = null;
      items.forEach(function (i) { if (i !== item && i.classList.contains('pinned')) anchor = i; });
      if (anchor && anchor.nextSibling) parent.insertBefore(item, anchor.nextSibling);
      else if (anchor) parent.appendChild(item);
      else { var fi = parent.querySelector(config.itemSelector); if (fi && fi !== item) parent.insertBefore(item, fi); }
    }
    if (config.onPin) config.onPin(item, pinned);
  }

  // ============ RENAME ============
  function openRenameEditor(item, config) {
    if (item.querySelector('.ss-rename-input')) return;
    var titleEl = item.querySelector(config.titleSelector || '.session-title, .sl-title');
    if (!titleEl) return;
    var oldTitle = titleEl.textContent.trim();
    var input = el('input', { class: 'ss-rename-input', type: 'text', maxlength: '60' });
    input.value = oldTitle;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    var done = false;
    function finish(val) {
      if (done) return; done = true;
      var newTitle = (val && val.trim()) || oldTitle;
      titleEl.textContent = newTitle;
      if (input.parentNode) input.replaceWith(titleEl);
      if (newTitle !== oldTitle) {
        if (config.onRename) config.onRename(item, newTitle, oldTitle);
        showToast('已重命名为「' + newTitle + '」', function () {
          titleEl.textContent = oldTitle;
          if (config.onRename) config.onRename(item, oldTitle, newTitle);
        });
      }
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(oldTitle); }
    });
    input.addEventListener('blur', function () { finish(input.value); });
  }

  // ============ EXPORT ============
  function openExportDialog(item, config) {
    currentTarget = item;
    currentConfig = config;
    exportEl.querySelector('.ss-export-target').textContent = config.getTitle(item) || '该会话';
    exportEl.querySelectorAll('.ss-format').forEach(function (f) { f.classList.remove('selected'); });
    var def = exportEl.querySelector('.ss-format[data-fmt="md"]');
    if (def) def.classList.add('selected');
    exportEl.classList.add('open');
  }
  function closeExportDialog() { if (exportEl) exportEl.classList.remove('open'); }

  function onConfirmExport() {
    if (!currentTarget) return;
    var item = currentTarget, config = currentConfig;
    var sel = exportEl.querySelector('.ss-format.selected');
    var fmt = sel ? sel.dataset.fmt : 'md';
    var title = config.getTitle(item) || '会话记录';
    var data = (config.getExportData ? config.getExportData(item) : null) || defaultExportData(item, config);
    var content = buildExport(data, fmt);
    var ext = fmt === 'json' ? 'json' : (fmt === 'txt' ? 'txt' : 'md');
    var filename = sanitizeFilename(title) + '.' + ext;
    downloadFile(filename, content);
    closeExportDialog();
    showToast('已导出 ' + filename);
  }

  function defaultExportData(item, config) {
    return {
      title: config.getTitle(item),
      id: config.getId(item),
      host: config.getHostName ? config.getHostName(item) : 'pocketctl 主机',
      createdAt: nowStr(),
      messages: [
        { role: 'user', content: '（示例）帮我分析现有代码结构并提出重构方案', time: '14:32' },
        { role: 'assistant', content: '好的，我来梳理当前实现并给出拆分建议。', time: '14:32' },
        { role: 'tool', content: 'read_file src/index.ts', time: '14:33' },
        { role: 'assistant', content: '已读取，建议拆分为独立模块以便维护。', time: '14:34' }
      ]
    };
  }

  function buildExport(data, fmt) {
    if (fmt === 'json') return JSON.stringify(data, null, 2);
    var lines = [];
    if (fmt === 'md') {
      lines.push('# ' + (data.title || '会话记录'));
      lines.push('');
      lines.push('> **会话 ID**：`' + (data.id || '-') + '`  ');
      lines.push('> **主机**：' + (data.host || '-') + '  ');
      lines.push('> **创建时间**：' + (data.createdAt || '-') + '  ');
      lines.push('> **导出时间**：' + nowStr());
      lines.push('');
      lines.push('---');
      lines.push('');
      (data.messages || []).forEach(function (m) {
        var who = m.role === 'user' ? '🧑 用户' : (m.role === 'assistant' ? '🤖 助手' : '🔧 工具调用');
        lines.push('### ' + who + ' · _' + (m.time || '') + '_');
        lines.push('');
        if (m.role === 'tool') lines.push('`' + m.content + '`');
        else lines.push(m.content);
        lines.push('');
      });
      lines.push('---');
      lines.push('');
      lines.push('_由 pocketctl 导出_');
      return lines.join('\n');
    }
    // txt
    lines.push('会话记录：' + (data.title || ''));
    lines.push('ID: ' + (data.id || '-') + '    主机: ' + (data.host || '-'));
    lines.push('创建时间: ' + (data.createdAt || '-'));
    lines.push('');
    (data.messages || []).forEach(function (m) {
      var who = m.role === 'user' ? '[用户]' : (m.role === 'assistant' ? '[助手]' : '[工具]');
      lines.push(who + ' ' + (m.time || '') + ': ' + m.content);
    });
    return lines.join('\n');
  }

  function sanitizeFilename(s) {
    return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'session';
  }

  function downloadFile(filename, content) {
    try {
      var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 200);
    } catch (e) { /* 预览环境可能拦截下载，静默处理 */ }
  }

  function nowStr() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // ============ DELETE ============
  function openDialog(item, config) {
    currentTarget = item;
    currentConfig = config;
    dialogEl.querySelector('.ss-dialog-target').textContent = config.getTitle(item) || '该会话';
    dialogEl.querySelector('.ss-confirm-label').textContent = '确认删除';
    dialogEl.querySelector('.ss-confirm').classList.remove('loading');
    dialogEl.classList.add('open');
  }
  function closeDialog() {
    if (!dialogEl) return;
    dialogEl.classList.remove('open');
    dialogEl.querySelector('.ss-confirm').classList.remove('loading');
  }
  function onConfirmDelete() {
    if (!currentTarget) return;
    var item = currentTarget;
    var config = currentConfig;
    dialogEl.querySelector('.ss-confirm').classList.add('loading');
    setTimeout(function () {  // 模拟网络往返；接入后端时替换为真实 API
      closeDialog();
      var title = config.getTitle(item) || '该会话';
      var undo = config.onDelete ? config.onDelete(item) : null;
      showToast('已删除「' + title + '」', undo);
    }, 700);
  }

  // ============ TOAST ============
  function showToast(text, undoFn) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = '';
    toastEl.appendChild(el('span', { class: 'ss-toast-msg', html: text }));
    if (typeof undoFn === 'function') {
      var undoBtn = el('button', { class: 'ss-toast-undo' });
      var secs = 5;
      undoBtn.textContent = '撤销 · ' + secs + 's';
      var tick = setInterval(function () {
        secs -= 1;
        if (secs <= 0) { clearInterval(tick); hideToast(); return; }
        undoBtn.textContent = '撤销 · ' + secs + 's';
      }, 1000);
      undoBtn.addEventListener('click', function () {
        clearInterval(tick);
        try { undoFn(); } catch (e) {}
        hideToast();
      });
      toastEl.appendChild(undoBtn);
      toastEl._tick = tick;
    }
    toastEl.classList.add('show');
    toastTimer = setTimeout(hideToast, 5500);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl && toastEl._tick) { clearInterval(toastEl._tick); toastEl._tick = null; }
    if (toastEl) toastEl.classList.remove('show');
  }

  window.PocketctlSession = {
    attach: attach,
    closeMenu: closeMenu,
    closeDialog: closeDialog,
    closeExportDialog: closeExportDialog,
    hideToast: hideToast
  };
})();
