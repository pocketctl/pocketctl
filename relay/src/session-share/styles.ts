// Based on the approved session-share-feed proposal and effective Web baseline tokens.
export const shareStyles = `/* Tokens copied from current Web baseline, including effective app overrides. */
:root{color-scheme:light;--bg:#f5f7fb;--panel:#fff;--rail:#fbfcfe;--soft:#f0f3f9;--hover:#f6f8fc;--line:#e5e9f1;--line-strong:#cbd4e3;--ink:#202c41;--muted:#65738b;--faint:#7d899e;--brand:#3869e8;--brand-hover:#2855ca;--brand-soft:#edf2ff;--green:#16805e;--green-soft:#eaf7f0;--amber:#996919;--amber-soft:#fff5e3;--red:#c44355;--red-soft:#fff0f2;--purple:#825ac5;--purple-soft:#f3eefc;--shadow:0 8px 30px #23365a09;--modal-shadow:0 24px 90px #101d3f2a;--overlay:#16203965;--r:14px;--rs:8px;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

[data-theme=dark]{color-scheme:dark;--bg:#101722;--panel:#182130;--rail:#131c29;--soft:#202c3d;--hover:#1c283a;--line:#2a3649;--line-strong:#44536d;--ink:#eaf0fb;--muted:#acb9ce;--faint:#8998b0;--brand:#8baeff;--brand-hover:#adc6ff;--brand-soft:#253553;--green:#75d7b2;--green-soft:#19372f;--amber:#edc279;--amber-soft:#382e20;--red:#ff9aa8;--red-soft:#39262e;--purple:#c2a7f0;--purple-soft:#302744;--shadow:0 8px 30px #0000000d;--modal-shadow:0 24px 90px #00000066;--overlay:#050b16b3}

.app{--header-h:56px;--bg:#f6f8fa;--panel:#fff;--rail:#fff;--soft:#eef1f5;--hover:#f6f8fa;--line:#d8e0e9;--line-strong:#c9d4e2;--ink:#1f2328;--muted:#667184;--faint:#7e8898;--brand:#0969da;--brand-soft:#e7f0fd;--green:#1a7f37;--green-soft:#eaf5ee;--amber:#9a6700;--amber-soft:#fff4df;--shadow:none;--r:12px;--rs:10px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:var(--bg)}

[data-theme=dark] .app{--bg:#0d1117;--panel:#161b22;--rail:#161b22;--soft:#1c2129;--hover:#1c2129;--line:#30363d;--line-strong:#484f58;--ink:#e6edf3;--muted:#8b949e;--faint:#8b949e;--brand:#58a6ff;--brand-soft:#1c304b;--green:#3fb950;--green-soft:#17332a;--amber:#d29922;--amber-soft:#352a1c}

*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;color:var(--ink)}
button,select{font:inherit;color:inherit}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
button,select{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:7px 10px;cursor:pointer}
button:hover{background:var(--soft)}
:focus-visible{outline:2px solid var(--brand);outline-offset:4px}
[hidden]{display:none!important}
.viewport{background:var(--panel);min-height:90vh;container-type:inline-size}
.site-header{max-width:1120px;margin:auto;padding:20px 32px;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:9px;font-size:19px;letter-spacing:-.6px;font-weight:650;color:var(--ink)}
.brand img{width:27px;height:27px}
.readonly{color:var(--muted);font-size:12px;border:1px solid var(--line);border-radius:20px;padding:4px 10px}
main{max-width:824px;margin:auto;padding:40px 32px 0}
.eyebrow{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted)}
h1{font-size:30px;letter-spacing:-.6px;line-height:1.35;margin:14px 0}
.description{color:var(--muted);font-size:15px;line-height:1.8;margin:0 0 20px}
.metadata{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.expiry{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:17px;font-size:12px;color:var(--muted)}
.dot{width:6px;height:6px;background:var(--amber);border-radius:50%}
.expiry-note{margin-left:auto}
.reading-nav{display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px 0;margin-top:30px;font-size:12px}
.reading-nav>span{font-weight:600}
.reading-nav>div{display:flex;gap:16px;align-items:center}
.reading-nav button{border:0;padding:6px 0;color:var(--muted);background:none}
.turn{padding-top:28px;scroll-margin-top:20px}
.turn-marker{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:11px;margin-bottom:17px}
.turn-marker span{font-family:var(--mono);color:var(--faint)}
.user-message{padding:17px 20px;border:1px solid var(--line);border-radius:12px;background:var(--hover)}
.message-meta{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted);gap:16px}
.message-meta strong{font-weight:600;display:flex;align-items:center;gap:8px;color:var(--ink)}
time{font-size:11px;font-variant-numeric:tabular-nums;color:var(--muted)}
article p,article li{font-size:16px;line-height:1.8;overflow-wrap:anywhere}
article p{margin:14px 0}
.user-message p{margin:10px 0 0}
.agent-message{padding:24px 0 30px}
.agent-dot{display:grid;place-items:center;width:21px;height:21px;border:1px solid var(--line);border-radius:6px;font-size:11px}
.agent-message h2{font-size:21px;line-height:1.5;margin:28px 0 12px;font-weight:650}
.agent-message h3{font-size:16px;margin:26px 0 12px}
ul{padding-left:23px}
li{padding-left:2px;margin:8px 0}
blockquote{border-left:3px solid var(--line-strong);padding:2px 18px;margin:24px 0;color:var(--muted);font-size:15px;line-height:1.8}
.process{border:1px solid var(--line);border-radius:10px;margin:21px 0;background:var(--panel);overflow:hidden}
summary{cursor:pointer;line-height:1.6}
.process>summary{list-style:none;display:flex;align-items:center;gap:12px;padding:13px 16px}
.process>summary::-webkit-details-marker{display:none}
.process-icon{color:var(--green);font-size:15px}
.process-title{font-size:13px;font-weight:550;flex:1}
.process-title small{display:block;font-size:11px;color:var(--muted);font-weight:400;margin-top:2px}
.process-status{font-size:11px;color:var(--muted)}
.chevron{color:var(--muted)}
.process[open] .chevron{transform:rotate(180deg)}
.process-body{border-top:1px solid var(--line);padding:0 16px}
.step{padding:12px 0;border-bottom:1px solid var(--line);font-size:12px}
.step:last-child{border:0}
.step code{color:var(--muted);font-size:11px;overflow-wrap:anywhere}
.step pre{white-space:pre-wrap;font-size:12px}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.7;min-width:430px}
th,td{text-align:left;border-bottom:1px solid var(--line);padding:11px 13px}
th{background:var(--hover);font-weight:550;color:var(--muted)}
.raw{font-size:12px;color:var(--muted);margin-top:24px}
.raw pre{white-space:pre-wrap}
.raw small{display:block}
.code-block{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:23px 0}
.code-head{background:var(--hover);padding:10px 16px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}
pre{padding:16px;background:var(--hover);font:13px/1.8 var(--mono);overflow-x:auto;margin:0;color:var(--ink)}
.warning{background:var(--amber-soft);border-left:3px solid var(--amber);padding:15px 18px;border-radius:6px;margin:20px 0;font-size:14px}
.warning p{font-size:14px;margin:6px 0 0}
.closing-note{font-size:12px;color:var(--muted);margin-top:24px}
.end{border-top:1px solid var(--line);display:flex;justify-content:space-between;padding:24px 0;font-size:12px;color:var(--muted)}
.site-footer{text-align:center;font-size:11px;color:var(--muted);padding:40px 20px}
.site-footer span{margin:0 10px}
.empty-state{text-align:center;padding:90px 0 150px}
.state-symbol{font-size:32px;color:var(--muted)}
.empty-state h1{font-size:23px}
.empty-state p{font-size:14px;line-height:1.8;color:var(--muted)}
.empty-state .subtle{font-size:12px;margin-top:25px}
@container(max-width:600px){.site-header{padding:18px 20px}
main{padding:24px 20px 0}
h1{font-size:25px}
.description{font-size:14px}
.metadata{gap:10px;font-size:11px}
.expiry-note{margin-left:13px;width:100%}
.reading-nav{align-items:flex-start}
.reading-nav>div{gap:6px;align-items:flex-end;flex-direction:column}
.reading-nav>span{padding-top:6px;white-space:nowrap}
.user-message{padding:14px 16px}
.process>summary{gap:9px;padding:12px}
.process-status{display:none}
.agent-message h2{font-size:20px}
.agent-message{padding-bottom:20px}
.empty-state{padding:55px 0 100px}
.empty-state h1{font-size:22px}}
@media(max-width:700px){}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}


@media(prefers-color-scheme:dark){body.app{--bg:#0d1117;--panel:#161b22;--rail:#161b22;--soft:#1c2129;--hover:#1c2129;--line:#30363d;--line-strong:#484f58;--ink:#e6edf3;--muted:#8b949e;--faint:#8b949e;--brand:#58a6ff;--brand-soft:#1c304b;--green:#3fb950;--green-soft:#17332a;--amber:#d29922;--amber-soft:#352a1c;color-scheme:dark}}

body.app:has(#theme-light:checked){--header-h:56px;--bg:#f6f8fa;--panel:#fff;--rail:#fff;--soft:#eef1f5;--hover:#f6f8fa;--line:#d8e0e9;--line-strong:#c9d4e2;--ink:#1f2328;--muted:#667184;--faint:#7e8898;--brand:#0969da;--brand-soft:#e7f0fd;--green:#1a7f37;--green-soft:#eaf5ee;--amber:#9a6700;--amber-soft:#fff4df;--shadow:none;--r:12px;--rs:10px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:var(--bg);color-scheme:light}

body.app:has(#theme-dark:checked){--bg:#0d1117;--panel:#161b22;--rail:#161b22;--soft:#1c2129;--hover:#1c2129;--line:#30363d;--line-strong:#484f58;--ink:#e6edf3;--muted:#8b949e;--faint:#8b949e;--brand:#58a6ff;--brand-soft:#1c304b;--green:#3fb950;--green-soft:#17332a;--amber:#d29922;--amber-soft:#352a1c;color-scheme:dark}


.header-actions{display:flex;align-items:center;gap:16px}
.appearance{position:relative;font-size:12px}
.appearance>summary{padding:8px;min-height:36px}
.appearance fieldset{position:absolute;right:0;top:32px;z-index:2;min-width:150px;padding:12px 16px;background:var(--panel);border:1px solid var(--line);border-radius:10px}
.appearance legend{font-size:11px;color:var(--muted)}
.appearance label{display:flex;align-items:center;gap:8px;padding:9px 0;cursor:pointer}
.appearance input{accent-color:var(--brand)}
.user-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:1.8;margin-top:10px}
.prose{overflow-wrap:anywhere;font-size:16px;line-height:1.8}
.prose>p:last-child{margin-bottom:0}
.prose h1{font-size:23px}
.prose h2{font-size:21px}
.prose h3{font-size:18px}
.prose pre{border:1px solid var(--line);border-radius:10px;margin:20px 0}
.prose :not(pre)>code{font: .88em var(--mono);background:var(--soft);padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}
.prose table{margin:12px 0}
.prose hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.subtle,.tool-owner{font-size:12px;color:var(--muted)}
.tool-status{float:right;color:var(--muted);font-size:11px;margin-left:12px}
.failed{color:var(--red);font-weight:600}
.process:has(.failed){border-color:var(--red)}
.process>summary:after{content:'⌄';color:var(--muted)}
.process[open]>summary:after{transform:rotate(180deg)}
.step h3{font-size:12px;color:var(--muted)}
.step pre{max-height:32rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.raw{margin:12px 0 24px}
.raw pre{max-height:32rem;overflow:auto;overflow-wrap:anywhere}
.raw summary{padding:8px 0}
.incomplete{color:var(--amber);font-size:12px;line-height:1.7}
.turn+.turn{border-top:1px solid var(--line);margin-top:24px}
.warning p{white-space:pre-wrap;overflow-wrap:anywhere}
.image-placeholder{color:var(--muted)}
.agent-message{padding-bottom:12px}
.prose img{max-width:100%}
summary:focus-visible{outline:2px solid var(--brand);outline-offset:3px}
@media(max-width:600px){.site-header{padding:16px 20px}
.reading-nav .subtle{font-size:11px}}

.process-status.failed{display:block}
.tool-status{float:none;display:inline-block}
.step summary{overflow-wrap:anywhere}
@media(prefers-color-scheme:dark){body.app{--red:#ff9aa8;--red-soft:#39262e}}
body.app:has(#theme-light:checked){--red:#c44355;--red-soft:#fff0f2}
body.app:has(#theme-dark:checked){--red:#ff9aa8;--red-soft:#39262e}
`;
