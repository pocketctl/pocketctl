/* ============================================
   pocketctl Landing Page — i18n & Interactions
   ============================================ */

/* ---- i18n Data ---- */
const i18n = {
  zh: {
    'nav.features': '功能',
    'nav.architecture': '架构',
    'nav.how': '使用方式',
    'nav.platforms': '平台',
    'nav.pricing': '定价',
    'nav.webapp': '打开 Web 客户端',
    'hero.badge': '现已开放内测',
    'hero.title1': '你的',
    'hero.titleAccent': 'AI 编程助手',
    'hero.title2': '尽在掌中',
    'hero.desc': 'pocketctl 让你从手机上远程监控和管理 Claude Code、Codex 等 AI 编程 Agent。实时查看进度、发送指令、随时掌控——无论你身在何处。',
    'hero.cta1': '下载 iOS App',
    'hero.cta2': '打开 Web 客户端',
    'mockup.daemons': '我的主机',
    'mockup.online': '在线',
    'mockup.offline': '离线',
    'mockup.input': '发送指令...',
    'trust.text': '兼容主流 AI 编程助手',
    'features.label': '功能特性',
    'features.title': '为开发者打造的控制中心',
    'features.desc': '实时监控、即时干预，让 AI Agent 在你掌控之中运行',
    'features.f1.title': '实时会话监控',
    'features.f1.desc': '查看 AI Agent 的每一步操作——代码读写、命令执行、文件搜索、工具调用。流式消息实时同步，传输过程中支持 Markdown 渲染，不错过任何细节。',
    'features.f2.title': '即时消息交互',
    'features.f2.desc': '随时向 Agent 发送新指令或回复，支持文本输入和语音转文字。无需回到电脑前，就能在手机上指导 AI 的下一步行动。',
    'features.f3.title': '智能推送通知',
    'features.f3.desc': 'Agent 完成任务、等待审批或遇到错误时，立即收到推送通知。支持自定义通知规则——按主机、会话类型、优先级筛选，只收你关心的内容。',
    'features.f4.title': '多主机统一管理',
    'features.f4.desc': '注册多台开发机，统一查看和管理。工作电脑、CI 服务器、远程工作站——一个 App 全部掌握。支持为每台主机设置自定义别名。',
    'features.f5.title': '多 Agent 支持',
    'features.f5.desc': '兼容 Claude Code、Codex、GitHub Copilot CLI、Cursor 等主流 AI 编程助手。统一的监控界面，无缝切换不同类型的 Agent 会话。',
    'features.f6.title': '端到端安全',
    'features.f6.desc': '端到端加密通信，Agent 仅在本地执行。你的代码永远不会离开你的机器。登录支持手机号+验证码、邮箱+验证码双重验证方式。',
    'arch.label': '系统架构',
    'arch.title': '你的手机如何控制 AI Agent',
    'arch.desc': '轻量级 Daemon 运行在你的开发机上，通过加密通道与手机 App 实时通信',
    'arch.node1.title': 'pocketctl App',
    'arch.node1.desc': 'iOS / Web 客户端\n实时查看和控制',
    'arch.node2.title': 'Relay Server',
    'arch.node2.desc': '加密消息中转\nNAT 穿透',
    'arch.node3.title': 'pocketctl Daemon',
    'arch.node3.desc': '运行在你的主机上\n管理 Agent 生命周期',
    'arch.node4.title': 'AI Agent',
    'arch.node4.desc': 'Claude Code / Codex\n本地执行代码任务',
    'how.label': '快速开始',
    'how.title': '三分钟完成配置',
    'how.desc': '无需复杂设置，几行命令即可将你的开发机接入 pocketctl',
    'how.step1.title': '安装 Daemon',
    'how.step1.desc': '在你的开发机上运行一行命令，自动安装并配置 pocketctl Daemon。支持 macOS、Linux。',
    'how.step2.title': '登录并启动',
    'how.step2.desc': '用手机号或邮箱注册账号，关联你的设备。Daemon 会在后台自动运行，重启后也会自动恢复。',
    'how.step3.title': '随时掌控',
    'how.step3.desc': '打开手机 App 或 Web 客户端，实时查看你的 AI Agent 工作状态，随时发送新指令或调整方向。',
    'platforms.label': '多平台支持',
    'platforms.title': '选择你的使用方式',
    'platforms.desc': 'iOS 原生 App 与 Web 客户端并行开发，数据实时同步',
    'platforms.ios.desc': '原生 iOS 应用，支持 Dynamic Island、推送通知、桌面 Widget。随时随地，一手掌控。',
    'platforms.web.desc': '浏览器即开即用，无需安装。深色/浅色双主题，大屏多面板布局，适合桌面端深度使用。',
    'platforms.web.cta': '立即体验 Web 客户端 →',
    'pricing.label': '定价方案',
    'pricing.title': '适合每个开发者',
    'pricing.desc': '从免费开始，按需升级',
    'pricing.free.name': '免费版',
    'pricing.free.desc': '个人开发者和小项目',
    'pricing.free.f1': '1 台主机',
    'pricing.free.f2': '基础会话监控',
    'pricing.free.f3': '消息交互',
    'pricing.free.f4': '单个 Agent 类型',
    'pricing.free.f5': '推送通知',
    'pricing.free.f6': 'Web 客户端',
    'pricing.free.cta': '免费开始',
    'pricing.pro.popular': '推荐',
    'pricing.pro.name': '专业版',
    'pricing.pro.desc': '专业开发者和团队',
    'pricing.pro.f1': '无限主机',
    'pricing.pro.f2': '完整会话监控',
    'pricing.pro.f3': '消息交互 + 文件传输',
    'pricing.pro.f4': '全部 Agent 类型',
    'pricing.pro.f5': '即时推送通知',
    'pricing.pro.f6': 'Web 客户端全功能',
    'pricing.pro.cta': '敬请期待',
    'faq.label': '常见问题',
    'faq.title': '你可能还想知道',
    'faq.q1': 'pocketctl 如何保证我的代码安全？',
    'faq.a1': 'pocketctl 采用端到端加密通信。AI Agent 的代码读写、命令执行全部在你的本地机器上完成，不会上传到任何第三方服务器。Relay Server 仅做加密消息中转，无法解密你的会话内容。你的代码永远不会离开你的机器。',
    'faq.q2': '支持哪些 AI 编程助手？',
    'faq.a2': '目前支持 Claude Code、Codex、GitHub Copilot CLI 和 Cursor。我们持续扩展 Agent 兼容列表——如果你使用的工具尚未支持，欢迎在 GitHub 提交 Issue 或通过 Web 客户端反馈。',
    'faq.q3': '需要在我的开发机上一直运行 Daemon 吗？',
    'faq.a3': '是的，Daemon 需要在开发机上保持运行才能接收来自手机的指令。它占用的系统资源极少（通常 < 50MB 内存），不会影响你的正常工作。你可以在不需要时通过 pocketctl daemon stop 随时停止。',
    'faq.q4': 'iOS App 和 Web 客户端数据互通吗？',
    'faq.a4': '完全互通。你的主机列表、会话记录、消息历史在同一账号下实时同步。在手机上发送的指令，在 Web 端也能看到完整的对话上下文。',
    'faq.q5': '免费版有什么限制？',
    'faq.a5': '免费版支持 1 台主机、基础会话监控、消息交互和单一 Agent 类型。如果需要管理多台主机、接收推送通知或使用 Web 客户端全功能，可以升级到专业版（¥48/月）。',
    'cta.title': '随时掌控你的 AI Agent',
    'cta.desc': '不再守在电脑前。pocketctl 让你的开发机随身携带——在咖啡厅、在地铁上、在任何地方。',
    'cta.btn1': '下载 iOS App',
    'cta.btn2': '打开 Web 客户端',
    'footer.desc': '远程掌控你的 AI 编程助手。iOS App + Web 客户端，实时监控、即时干预。',
    'footer.product': '产品',
    'footer.features': '功能特性',
    'footer.pricing': '定价方案',
    'footer.platforms': '平台支持',
    'footer.webapp': 'Web 客户端',
    'footer.resources': '资源',
    'footer.docs': '使用文档',
    'footer.api': 'API 参考',
    'footer.github': 'GitHub',
    'footer.changelog': '更新日志',
    'footer.legal': '法律',
    'footer.privacy': '隐私政策',
    'footer.terms': '用户协议',
    'footer.contact': '联系我们',
    'footer.status': '服务状态',
    'ios.feature1': '实时推送通知，Agent 状态变化即时知晓',
    'ios.feature2': '桌面 Widget 小组件，主屏速览主机状态',
    'ios.feature3': 'Dynamic Island 灵动岛显示活跃会话',
    'ios.feature4': 'Face ID / Touch ID 安全解锁',
    'web.feature1': '深色 / 浅色双主题，自动跟随系统',
    'web.feature2': '三栏布局：侧栏 + 列表 + 详情',
    'web.feature3': '代码高亮 + 工具调用展开',
    'web.feature4': '响应式适配桌面 / 平板',
    'modal.ios.title': 'iOS App 内邀测试中',
    'modal.ios.desc': '感谢你对 pocketctl 的关注！iOS App 目前处于内部测试阶段，预计即将开放。留下你的邮箱，我们会在第一时间通知你。',
    'modal.ios.placeholder': 'your@email.com',
    'modal.ios.submit': '立即预约',
    'modal.ios.success': '已收到！我们会在 TestFlight 开放时通知你。',
  },
  en: {
    'nav.features': 'Features',
    'nav.architecture': 'Architecture',
    'nav.how': 'How It Works',
    'nav.platforms': 'Platforms',
    'nav.pricing': 'Pricing',
    'nav.webapp': 'Open Web Client',
    'hero.badge': 'Beta Access Now Open',
    'hero.title1': 'Your',
    'hero.titleAccent': 'AI Coding Assistant',
    'hero.title2': 'in Your Pocket',
    'hero.desc': 'pocketctl lets you remotely monitor and manage Claude Code, Codex, and other AI coding agents from your phone. View progress in real time, send commands, and stay in control — wherever you are.',
    'hero.cta1': 'Download iOS App',
    'hero.cta2': 'Open Web Client',
    'mockup.daemons': 'My Hosts',
    'mockup.online': 'Online',
    'mockup.offline': 'Offline',
    'mockup.input': 'Send a command...',
    'trust.text': 'Compatible with Leading AI Coding Assistants',
    'features.label': 'Features',
    'features.title': 'A Control Center Built for Developers',
    'features.desc': 'Real-time monitoring, instant intervention — keep your AI agents under your control',
    'features.f1.title': 'Real-time Session Monitoring',
    'features.f1.desc': 'Watch every step your AI agent takes — code read/write, command execution, file search, tool calls. Streaming messages synced in real time with full Markdown rendering.',
    'features.f2.title': 'Instant Message Interaction',
    'features.f2.desc': 'Send new instructions or replies to your agent anytime. No need to be at your desk — guide your AI\'s next move from your phone.',
    'features.f3.title': 'Smart Push Notifications',
    'features.f3.desc': 'Get notified instantly when your agent completes a task, awaits approval, or hits an error. Customize notification rules by host, session type, and priority.',
    'features.f4.title': 'Multi-Host Management',
    'features.f4.desc': 'Register multiple development machines and manage them in one place. Work laptop, CI server, remote workstation — all in one app. Set custom aliases for each host.',
    'features.f5.title': 'Multi-Agent Support',
    'features.f5.desc': 'Compatible with Claude Code, Codex, GitHub Copilot CLI, Cursor, and more. A unified monitoring interface that seamlessly switches between different agent sessions.',
    'features.f6.title': 'End-to-End Security',
    'features.f6.desc': 'End-to-end encrypted communication. Agents execute locally — your code never leaves your machine. Login supports phone + OTP and email + OTP dual verification.',
    'arch.label': 'Architecture',
    'arch.title': 'How Your Phone Controls AI Agents',
    'arch.desc': 'A lightweight Daemon runs on your dev machine, communicating with your phone app in real time through encrypted channels',
    'arch.node1.title': 'pocketctl App',
    'arch.node1.desc': 'iOS / Web Client\nReal-time view & control',
    'arch.node2.title': 'Relay Server',
    'arch.node2.desc': 'Encrypted message relay\nNAT traversal',
    'arch.node3.title': 'pocketctl Daemon',
    'arch.node3.desc': 'Runs on your host\nManages agent lifecycle',
    'arch.node4.title': 'AI Agent',
    'arch.node4.desc': 'Claude Code / Codex\nExecutes tasks locally',
    'how.label': 'Quick Start',
    'how.title': 'Set Up in Three Minutes',
    'how.desc': 'No complex configuration — a few commands to connect your dev machine to pocketctl',
    'how.step1.title': 'Install Daemon',
    'how.step1.desc': 'Run a single command on your dev machine to automatically install and configure the pocketctl Daemon. Supports macOS and Linux.',
    'how.step2.title': 'Log In & Start',
    'how.step2.desc': 'Sign up with your phone number or email, then link your device. The Daemon runs in the background and auto-recovers after restarts.',
    'how.step3.title': 'Stay in Control',
    'how.step3.desc': 'Open the app or web client to view your AI agent\'s status in real time. Send new instructions or adjust direction anytime, anywhere.',
    'platforms.label': 'Multi-Platform',
    'platforms.title': 'Choose How You Work',
    'platforms.desc': 'Native iOS app and web client developed in parallel, with real-time data sync',
    'platforms.ios.desc': 'Native iOS experience with Dynamic Island, push notifications, and desktop widgets. Full control in your pocket.',
    'platforms.web.desc': 'Open in your browser — no installation needed. Dark/light dual themes, large-screen multi-panel layout, ideal for deep desktop use.',
    'platforms.web.cta': 'Try the Web Client →',
    'pricing.label': 'Pricing',
    'pricing.title': 'For Every Developer',
    'pricing.desc': 'Start free, upgrade as you grow',
    'pricing.free.name': 'Free',
    'pricing.free.desc': 'For individual devs & small projects',
    'pricing.free.f1': '1 Host',
    'pricing.free.f2': 'Basic Session Monitoring',
    'pricing.free.f3': 'Message Interaction',
    'pricing.free.f4': 'Single Agent Type',
    'pricing.free.f5': 'Push Notifications',
    'pricing.free.f6': 'Web Client',
    'pricing.free.cta': 'Get Started Free',
    'pricing.pro.popular': 'Popular',
    'pricing.pro.name': 'Pro',
    'pricing.pro.desc': 'For professional devs & teams',
    'pricing.pro.f1': 'Unlimited Hosts',
    'pricing.pro.f2': 'Full Session Monitoring',
    'pricing.pro.f3': 'Message + File Transfer',
    'pricing.pro.f4': 'All Agent Types',
    'pricing.pro.f5': 'Instant Push Notifications',
    'pricing.pro.f6': 'Full Web Client Access',
    'pricing.pro.cta': 'Coming Soon',
    'faq.label': 'FAQ',
    'faq.title': 'You Might Be Wondering',
    'faq.q1': 'How does pocketctl keep my code secure?',
    'faq.a1': 'pocketctl uses end-to-end encrypted communication. All code reading, writing, and command execution by AI agents happens locally on your machine and is never uploaded to any third-party server. The Relay Server only relays encrypted messages and cannot decrypt your session content.',
    'faq.q2': 'Which AI coding assistants are supported?',
    'faq.a2': 'We currently support Claude Code, Codex, GitHub Copilot CLI, and Cursor. We\'re continuously expanding our agent compatibility list — if your tool isn\'t supported yet, feel free to submit an issue on GitHub or send feedback through the web client.',
    'faq.q3': 'Does the Daemon need to run constantly on my dev machine?',
    'faq.a3': 'Yes, the Daemon needs to stay running on your dev machine to receive commands from your phone. It uses minimal system resources (typically < 50MB RAM) and won\'t affect your normal workflow. You can stop it anytime with pocketctl daemon stop.',
    'faq.q4': 'Does data sync between iOS app and web client?',
    'faq.a4': 'Completely. Your host list, session history, and message records sync in real time under the same account. Commands sent from your phone will appear with full conversation context in the web client.',
    'faq.q5': 'What are the limitations of the free plan?',
    'faq.a5': 'The free plan includes 1 host, basic session monitoring, message interaction, and a single agent type. If you need to manage multiple hosts, receive push notifications, or use the full web client, upgrade to Pro (¥48/month).',
    'cta.title': 'Keep Your AI Agents in Your Pocket',
    'cta.desc': 'Stop being chained to your desk. pocketctl brings your dev machine with you — at the coffee shop, on the subway, anywhere.',
    'cta.btn1': 'Download iOS App',
    'cta.btn2': 'Open Web Client',
    'footer.desc': 'Remote control for your AI coding assistants. iOS App + Web Client. Real-time monitoring, instant intervention.',
    'footer.product': 'Product',
    'footer.features': 'Features',
    'footer.pricing': 'Pricing',
    'footer.platforms': 'Platforms',
    'footer.webapp': 'Web Client',
    'footer.resources': 'Resources',
    'footer.docs': 'Documentation',
    'footer.api': 'API Reference',
    'footer.github': 'GitHub',
    'footer.changelog': 'Changelog',
    'footer.legal': 'Legal',
    'footer.privacy': 'Privacy Policy',
    'footer.terms': 'Terms of Service',
    'footer.contact': 'Contact Us',
    'footer.status': 'Status',
    'ios.feature1': 'Real-time push notifications for agent status changes',
    'ios.feature2': 'Home screen widget for at-a-glance host status',
    'ios.feature3': 'Dynamic Island shows active sessions',
    'ios.feature4': 'Face ID / Touch ID secure unlock',
    'web.feature1': 'Dark / Light dual themes, follows system preference',
    'web.feature2': 'Three-column layout: sidebar + list + detail',
    'web.feature3': 'Syntax highlighting + expandable tool calls',
    'web.feature4': 'Responsive design for desktop & tablet',
    'modal.ios.title': 'iOS App — Beta Testing',
    'modal.ios.desc': 'Thanks for your interest in pocketctl! The iOS app is currently in internal testing and will be available soon. Leave your email and we\'ll notify you as soon as it\'s ready.',
    'modal.ios.placeholder': 'your@email.com',
    'modal.ios.submit': 'Notify Me',
    'modal.ios.success': 'Got it! We\'ll let you know when TestFlight opens.',
  }
};

/* ---- State ---- */
let currentLang = 'zh';
let currentTheme = 'dark';

/* ---- Language Switcher ---- */
function setLanguage(lang) {
  currentLang = lang;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (i18n[lang] && i18n[lang][key]) {
      el.textContent = i18n[lang][key];
    }
  });
  // Handle placeholder i18n
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (i18n[lang] && i18n[lang][key]) {
      el.placeholder = i18n[lang][key];
    }
  });
  // Update lang toggle button
  const btn = document.getElementById('langToggle');
  btn.textContent = lang === 'zh' ? 'EN' : '中';
  btn.classList.toggle('active', lang === 'en');
  localStorage.setItem('pocketctl-lang', lang);
}

/* ---- Theme Switcher ---- */
function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  // Update theme icon (sun for dark mode, moon for light mode)
  const btn = document.getElementById('themeToggle');
  const isDark = theme === 'dark';
  btn.innerHTML = isDark
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  localStorage.setItem('pocketctl-theme', theme);
}

/* ---- Init ---- */
document.addEventListener('DOMContentLoaded', () => {
  const savedLang = localStorage.getItem('pocketctl-lang') || 'zh';
  const savedTheme = localStorage.getItem('pocketctl-theme') || 'dark';
  setLanguage(savedLang);
  setTheme(savedTheme);

  /* FAQ Accordion */
  document.querySelectorAll('.faq-item').forEach(item => {
    item.addEventListener('click', () => {
      item.classList.toggle('open');
    });
  });

  /* Mobile Menu */
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('navLinks').classList.toggle('open');
  });

  /* Scroll Reveal */
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

  /* Language Toggle */
  document.getElementById('langToggle').addEventListener('click', () => {
    setLanguage(currentLang === 'zh' ? 'en' : 'zh');
  });

  /* Theme Toggle */
  document.getElementById('themeToggle').addEventListener('click', () => {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  });

  /* Close mobile menu on link click */
  document.querySelectorAll('#navLinks a').forEach(link => {
    link.addEventListener('click', () => {
      document.getElementById('navLinks').classList.remove('open');
    });
  });

  /* ---- iOS Invite Modal ---- */
  const iosModal = document.getElementById('iosModal');
  const iosModalClose = document.getElementById('iosModalClose');
  const iosInviteForm = document.getElementById('iosInviteForm');
  const iosInviteSuccess = document.getElementById('iosInviteSuccess');

  function openIOSModal() {
    iosModal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeIOSModal() {
    iosModal.classList.remove('open');
    document.body.style.overflow = '';
  }

  // Open modal on all iOS download buttons
  document.querySelectorAll('.ios-download-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openIOSModal();
    });
  });

  // Close on X button
  iosModalClose.addEventListener('click', closeIOSModal);

  // Close on overlay click
  iosModal.addEventListener('click', (e) => {
    if (e.target === iosModal) closeIOSModal();
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && iosModal.classList.contains('open')) closeIOSModal();
  });

  // Handle form submit
  iosInviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = iosInviteForm.querySelector('input');
    const email = input.value.trim();
    if (!email) return;

    try {
      const resp = await fetch('/api/waitlist/ios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (resp.ok) {
        // Show success
        iosInviteForm.style.display = 'none';
        iosInviteSuccess.style.display = 'block';
      } else {
        const data = await resp.json();
        input.style.borderColor = 'var(--error)';
        input.setCustomValidity(data.error || '提交失败');
        input.reportValidity();
        setTimeout(() => {
          input.style.borderColor = '';
          input.setCustomValidity('');
        }, 3000);
        return;
      }
    } catch {
      input.style.borderColor = 'var(--error)';
      input.setCustomValidity('网络错误，请稍后再试');
      input.reportValidity();
      setTimeout(() => {
        input.style.borderColor = '';
        input.setCustomValidity('');
      }, 3000);
      return;
    }

    // Auto close after 3 seconds
    setTimeout(() => {
      closeIOSModal();
      // Reset after close animation
      setTimeout(() => {
        iosInviteForm.style.display = '';
        iosInviteSuccess.style.display = 'none';
        iosInviteForm.reset();
      }, 300);
    }, 3000);
  });
});
