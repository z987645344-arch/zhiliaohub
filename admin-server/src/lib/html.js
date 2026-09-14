// Provides minimal escaping and page framing for the server-rendered admin UI.
function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(value) {
  if (!value) return '';
  const raw = String(value);
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return raw;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}.${part('month')}.${part('day')} ${part('hour')}:${part('minute')} UTC+8`;
}

function adminNavigationScript() {
  return `'use strict';
(() => {
  document.documentElement.classList.add('js');
  const navToggle = document.querySelector('.nav-toggle');
  const adminNav = document.querySelector('.admin-nav');
  if (!navToggle || !adminNav) return;

  const closeNavigation = () => {
    navToggle.setAttribute('aria-expanded', 'false');
    adminNav.classList.remove('is-open');
  };

  navToggle.addEventListener('click', () => {
    const willOpen = navToggle.getAttribute('aria-expanded') !== 'true';
    navToggle.setAttribute('aria-expanded', String(willOpen));
    adminNav.classList.toggle('is-open', willOpen);
  });

  adminNav.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeNavigation();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeNavigation();
  });

  document.addEventListener('click', (event) => {
    if (!adminNav.classList.contains('is-open')) return;
    if (!adminNav.contains(event.target) && !navToggle.contains(event.target)) closeNavigation();
  });

  window.matchMedia('(min-width: 721px)').addEventListener('change', (event) => {
    if (event.matches) closeNavigation();
  });
})();`;
}

function layout({ title, content, authenticated = false, csrfToken = '' }) {
  const navigation = authenticated
    ? `<button type="button" class="nav-toggle" aria-expanded="false" aria-controls="admin-navigation" aria-label="展开或收起管理导航"><span aria-hidden="true"></span><span aria-hidden="true"></span></button><nav id="admin-navigation" class="admin-nav" aria-label="管理导航"><a href="/admin"><span>01</span>管理面板</a><a href="/admin/feedback"><span>02</span>反馈审核</a><a href="/admin/lab"><span>03</span>小作坊</a><a href="/admin/device"><span>04</span>设备管理</a><form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit" class="link-button">退出登录</button></form></nav>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}｜知了hub 管理后台</title>
  <style>
    :root {
      color-scheme: dark;
      --paper: #20282d;
      --ink: #eff2f3;
      --ink-soft: #bac4c9;
      --forest: #2a333a;
      --acid: #b3b7a4;
      --acid-strong: #c8cdb8;
      --line: rgba(239, 242, 243, 0.16);
      --white: #eff2f3;
      --surface: #2a333a;
      --surface-raised: #323e45;
      --button-ink: #222a2e;
      --danger: #f0b0a6;
      --danger-bg: #3f2d2e;
      --warning: #e6ce9a;
      --warning-bg: #39352b;
      --success: #b9cbb1;
      --success-bg: #2d3a34;
      --focus: rgba(179, 183, 164, 0.3);
      --font-sans: "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
      --font-mono: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
      --radius-lg: 24px;
      --radius-md: 16px;
      --radius-sm: 10px;
      --space-1: 8px;
      --space-2: 16px;
      --space-3: 24px;
      --space-4: 40px;
      --space-5: 64px;
      --ease: cubic-bezier(0.22, 1, 0.36, 1);
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
      font-size: 15px;
      line-height: 1.6;
      letter-spacing: 0.01em;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
    }
    body::before {
      position: fixed;
      inset: 0;
      z-index: -1;
      background-image:
        linear-gradient(115deg, var(--paper), transparent 46%),
        repeating-linear-gradient(90deg, transparent 0 79px, var(--paper) 80px);
      content: "";
      pointer-events: none;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      min-height: 56px;
      padding: 0.85rem max(1.25rem, calc((100% - 1100px) / 2));
      background: var(--forest);
      color: var(--white);
    }
    header strong {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 15px;
      letter-spacing: -0.01em;
    }
    header strong::before {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--acid);
      content: "";
    }
    header a { color: var(--white); text-decoration: none; }
    nav { display: flex; gap: 1.25rem; align-items: center; }
    nav a {
      position: relative;
      padding: 6px 0;
      font-size: 13px;
      font-weight: 600;
      opacity: 0.75;
      transition: opacity 200ms var(--ease);
    }
    nav a:hover { opacity: 1; }
    nav a[aria-current="page"] {
      opacity: 1;
      border-bottom: 2px solid var(--acid);
    }
    nav form { margin: 0; }
    main { width: min(1100px, calc(100% - 2rem)); margin: 2rem auto; }
    h1 {
      margin: 0 0 1.25rem;
      font-size: 1.75rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.2;
    }
    h2 {
      margin: 0 0 0.75rem;
      font-size: 1.15rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .panel {
      padding: 1.5rem;
      margin-bottom: 1.25rem;
      border: 1px solid var(--line);
      border-radius: 0.75rem;
      background: var(--surface);
      box-shadow: 0 1px 3px transparent;
    }
    .narrow { max-width: 520px; margin-inline: auto; }
    .notice {
      padding: 0.75rem 1rem;
      margin-bottom: 1.25rem;
      border: 1px solid var(--line);
      border-left: 3px solid var(--acid-strong);
      border-radius: 0.5rem;
      background: var(--surface);
      font-size: 13px;
    }
    .error {
      border-left-color: var(--danger);
      background: var(--danger-bg);
      color: var(--danger);
    }
    .warning {
      border-left-color: var(--warning);
      background: var(--warning-bg);
      color: var(--warning);
    }
    label {
      display: block;
      margin-top: 1rem;
      font-weight: 600;
      font-size: 13px;
      letter-spacing: 0.01em;
    }
    input, textarea, select {
      width: 100%;
      padding: 0.65rem 0.75rem;
      margin-top: 0.35rem;
      border: 1px solid var(--line);
      border-radius: 0.4rem;
      background: var(--surface);
      color: var(--ink);
      font: inherit;
      outline: none;
      transition: border-color 200ms var(--ease), box-shadow 200ms var(--ease), background 200ms var(--ease);
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--acid-strong);
      background: var(--surface);
      box-shadow: 0 0 0 3px var(--focus);
    }
    textarea {
      min-height: 14rem;
      line-height: 1.7;
      font-size: 14px;
      resize: vertical;
    }
    button, .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: auto;
      min-height: 42px;
      padding: 0 1.1rem;
      margin-top: 1rem;
      border: 1px solid var(--forest);
      border-radius: 0.4rem;
      color: var(--white);
      background: var(--forest);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: transform 200ms var(--ease), background 200ms var(--ease), color 200ms var(--ease), border-color 200ms var(--ease);
    }
    button:hover, .button:hover {
      transform: translateY(-1px);
      background: var(--ink);
      border-color: var(--ink);
    }
    .button-secondary {
      border-color: var(--line);
      background: transparent;
      color: var(--ink);
    }
    .button-secondary:hover {
      background: var(--surface-raised);
      border-color: var(--ink-soft);
      color: var(--ink);
    }
    .button-danger {
      border-color: var(--danger);
      background: transparent;
      color: var(--danger);
    }
    .button-danger:hover {
      background: var(--danger);
      border-color: var(--danger);
      color: var(--button-ink);
    }
    .link-button {
      padding: 6px 0;
      margin: 0;
      min-height: auto;
      border: 0;
      background: transparent;
      color: var(--ink-soft);
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: color 200ms var(--ease);
    }
    .link-button:hover {
      color: var(--acid);
      transform: none;
      background: transparent;
    }
    table { width: 100%; border-collapse: collapse; }
    th {
      padding: 0.7rem 0.5rem;
      border-bottom: 2px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-soft);
    }
    td {
      padding: 0.8rem 0.5rem;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }
    tbody tr { transition: background 150ms var(--ease); }
    tbody tr:hover { background: var(--surface); }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem; }
    code { overflow-wrap: anywhere; font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace; font-size: 0.9em; }
    .pairing-code {
      display: inline-block;
      padding: 0.55rem 0.75rem;
      font-size: 1.35rem;
      letter-spacing: 0.12em;
      font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
      background: var(--surface-raised);
      border-radius: 0.4rem;
    }
    img.qr { display: block; width: min(260px, 100%); height: auto; margin: 1rem 0; border: 1px solid var(--line); border-radius: 0.5rem; }
    .work-form-panel { max-width: 900px; margin-inline: auto; }
    .form-section {
      min-width: 0;
      padding: 1.25rem;
      margin: 1.5rem 0;
      border: 1px solid var(--line);
      border-radius: 0.65rem;
      background: var(--paper);
    }
    .form-section legend { padding: 0 0.5rem; font-weight: 700; letter-spacing: -0.01em; }
    .form-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(180px, 1fr); gap: 1rem; }
    .short-textarea { min-height: 7rem; }
    .hint { margin: 0 0 0.75rem; color: var(--ink-soft); font-size: 13px; }
    .choice-row { display: flex; flex-wrap: wrap; gap: 0.75rem 1.25rem; margin-top: 0.75rem; }
    .choice {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      width: auto;
      margin-top: 0;
      font-weight: 600;
    }
    .choice input { width: auto; margin: 0; }
    .checkbox-choice { margin-top: 0.5rem; }
    .upload-preview {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem;
      min-height: 1rem;
      margin-top: 0.75rem;
    }
    .upload-preview img, .upload-preview video {
      width: min(240px, 100%);
      max-height: 150px;
      border: 1px solid var(--line);
      border-radius: 0.45rem;
      background: var(--forest);
      object-fit: cover;
    }
    .upload-filename { max-width: 100%; overflow-wrap: anywhere; color: var(--ink-soft); font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px; }
    .compact-button { min-height: 34px; padding: 0 0.75rem; margin-top: 0; font-size: 12px; }
    .gallery-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 0.75rem;
      margin-top: 0.75rem;
    }
    .gallery-item {
      display: grid;
      gap: 0.5rem;
      min-width: 0;
      padding: 0.65rem;
      border: 1px solid var(--line);
      border-radius: 0.5rem;
      background: var(--surface);
    }
    .gallery-item img, .gallery-item video { width: 100%; aspect-ratio: 16 / 9; border-radius: 0.35rem; background: var(--forest); object-fit: cover; }
    .gallery-item span { overflow-wrap: anywhere; font-size: 12px; color: var(--ink-soft); }
    .cropper { margin-top: 0.75rem; }
    .cropper canvas {
      display: block;
      width: auto;
      max-width: 100%;
      max-height: 480px;
      border: 1px solid var(--line);
      border-radius: 0.45rem;
      background: var(--forest);
      cursor: default;
      touch-action: none;
    }
    .upload-status { min-height: 1.5rem; margin: 0.75rem 0 0; color: var(--ink-soft); font-size: 13px; }
    .upload-status.error { padding: 0; border: 0; background: transparent; }
    .feedback-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .feedback-filters { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .feedback-filters .button { min-height: 36px; padding: 0 0.8rem; margin: 0; font-size: 13px; }
    .feedback-filters .is-active { border-color: var(--forest); background: var(--forest); color: var(--white); }
    .feedback-topic { overflow: hidden; }
    .feedback-topic > header {
      min-height: 0;
      padding: 0 0 0.85rem;
      border-bottom: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
    }
    .feedback-message {
      min-width: 0;
      padding: 1rem;
      margin-top: 1rem;
      border: 1px solid var(--line);
      border-left: 4px solid var(--acid-strong);
      border-radius: 0.55rem;
      background: var(--surface);
    }
    .feedback-message.is-pending { border-left-color: var(--warning); background: var(--warning-bg); }
    .feedback-message.is-rejected { border-left-color: var(--ink-soft); background: var(--paper); }
    .feedback-reply { margin-left: 2rem; }
    .feedback-message-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.45rem 0.75rem;
      color: var(--ink-soft);
      font-size: 12px;
    }
    .feedback-message-head strong { color: var(--ink); font-size: 14px; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 0.55rem;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
    }
    .status-pending { border-color: var(--warning); background: var(--warning-bg); color: var(--warning); }
    .status-approved { border-color: var(--success); background: var(--success-bg); color: var(--success); }
    .status-rejected { background: var(--paper); color: var(--ink-soft); }
    .admin-badge { border-color: var(--line); background: var(--forest); color: var(--white); }
    .feedback-body { margin: 0.75rem 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .feedback-source { margin-top: 0.65rem; color: var(--ink-soft); font-size: 12px; }
    .feedback-source summary { width: fit-content; cursor: pointer; }
    .feedback-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
    .feedback-actions form { margin: 0; }
    .feedback-actions button { min-height: 34px; padding: 0 0.75rem; margin: 0; font-size: 12px; }
    .admin-reply-form { padding-top: 0.25rem; }
    .admin-reply-form textarea { min-height: 6rem; }
    .empty-state { margin: 0; color: var(--ink-soft); }
    .backup-status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    .backup-status {
      border-left: 5px solid var(--success);
      background: var(--success-bg);
    }
    .backup-status p { margin: 0.2rem 0; }
    .backup-status h2 { margin: 0.1rem 0 0.35rem; color: var(--success); font-size: 1.45rem; }
    .backup-status small { display: block; margin-top: 0.5rem; color: var(--ink-soft); }
    .backup-status-kicker { color: var(--ink-soft); font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
    .backup-status-danger {
      border: 2px solid var(--danger);
      border-left-width: 8px;
      background: var(--danger-bg);
      box-shadow: 0 3px 12px transparent;
    }
    .backup-status-danger h2 { color: var(--danger); }
    @media (max-width: 680px) { .backup-status-grid { grid-template-columns: 1fr; } }
    .lab-list { display: grid; gap: 1rem; }
    .lab-project { display: grid; gap: 0.8rem; }
    .lab-project-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.75rem; }
    .lab-project-head h2 { margin: 0; }
    .lab-project-meta { margin: 0; color: var(--ink-soft); font-size: 13px; }
    .lab-link-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 0.6rem; align-items: end; }
    .lab-link-row input { margin: 0; font-family: "Cascadia Mono", Consolas, monospace; font-size: 12px; }
    .lab-link-row .button, .lab-link-row button { min-height: 42px; margin: 0; white-space: nowrap; }
    .lab-actions { display: flex; flex-wrap: wrap; gap: 0.6rem; }
    .lab-actions form { margin: 0; }
    .lab-actions button { margin: 0; }
    @media (max-width: 720px) {
      .grid { grid-template-columns: 1fr; }
      .form-grid { grid-template-columns: 1fr; gap: 0; }
      table { font-size: 0.9rem; display: block; overflow-x: auto; }
      header { flex-direction: column; align-items: flex-start; gap: 0.5rem; padding-bottom: 1rem; }
      nav { flex-wrap: wrap; gap: 0.75rem; }
      main { margin: 1.25rem auto; }
      .panel { padding: 1.25rem; }
      .feedback-reply { margin-left: 0.75rem; }
      .feedback-message { padding: 0.85rem; }
      .lab-link-row { grid-template-columns: 1fr; }
      .lab-link-row .button, .lab-link-row button { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }

    /* Archive language, with denser controls for editing. */
    body { font-family: var(--font-sans); }
    body::before { display: none; }
    body > header { position: sticky; top: 0; z-index: 20; min-height: 88px; background: var(--paper); background: color-mix(in srgb, var(--paper) 88%, transparent); border-bottom: 1px solid var(--line); padding-inline: max(24px, calc((100% - 1180px) / 2)); backdrop-filter: blur(18px) saturate(1.2); -webkit-backdrop-filter: blur(18px) saturate(1.2); }
    .admin-brand { display: flex; align-items: center; gap: 12px; }
    .admin-brand .brand-mark { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--acid); color: var(--button-ink); font-weight: 700; }
    .admin-brand strong { display: block; }
    .admin-brand strong::before { display: none; }
    .admin-brand small, .admin-kicker, .section-number { font-family: var(--font-mono); font-size: 11px; letter-spacing: .14em; color: var(--ink-soft); }
    .admin-brand small { display: block; font-size: 9px; }
    nav a { display: flex; align-items: center; gap: 7px; }
    nav a span { font-family: var(--font-mono); font-size: 10px; color: var(--acid); }
    .nav-toggle { display: none; width: 44px; height: 44px; min-height: 44px; padding: 0; border: 1px solid var(--line); border-radius: 50%; background: transparent; color: var(--ink); }
    .nav-toggle:hover { background: var(--surface-raised); border-color: var(--ink-soft); }
    .nav-toggle span { display: block; width: 17px; height: 1.5px; margin: 5px auto; background: currentColor; transition: transform 250ms var(--ease); }
    .nav-toggle[aria-expanded="true"] span:first-child { transform: translateY(3.25px) rotate(45deg); }
    .nav-toggle[aria-expanded="true"] span:last-child { transform: translateY(-3.25px) rotate(-45deg); }
    main { width: min(1180px, calc(100% - 48px)); margin: var(--space-5) auto; }
    h1 { font-size: clamp(32px, 4.2vw, 54px); font-weight: 650; line-height: 1.18; margin-bottom: var(--space-3); }
    h2 { font-size: 22px; font-weight: 600; }
    p { overflow-wrap: anywhere; }
    .panel { border-radius: var(--radius-md); padding: clamp(24px, 3.4vw, 40px); box-shadow: none; margin-bottom: var(--space-3); }
    .panel > p:not(.notice) { color: var(--ink-soft); max-width: 72ch; }
    .narrow { max-width: 560px; margin-top: 8vh; padding: clamp(28px, 4vw, 56px); }
    .narrow button[type=submit] { width: 100%; }
    .admin-kicker { margin: 0 0 var(--space-3); text-transform: uppercase; }
    a { color: var(--ink); text-underline-offset: 4px; }
    a:hover { color: var(--acid-strong); }
    ::selection { color: var(--button-ink); background: var(--acid); }
    :root { scrollbar-color: var(--ink-soft) var(--paper); }
    :focus-visible { outline: 2px solid var(--acid-strong); outline-offset: 4px; }
    input, textarea, select { border-radius: var(--radius-sm); background: var(--paper); padding: 12px 14px; min-height: 48px; }
    input::placeholder, textarea::placeholder { color: var(--ink-soft); opacity: 1; }
    input[type=checkbox], input[type=radio] { min-height: 18px; width: 18px; height: 18px; accent-color: var(--acid); flex: 0 0 auto; }
    input[type=file] { font-size: 13px; }
    input::file-selector-button { background: var(--surface-raised); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px 12px; margin-right: 12px; cursor: pointer; }
    button, .button { min-height: 46px; border-radius: var(--radius-sm); background: var(--acid); color: var(--button-ink); border-color: var(--acid); }
    button:hover, .button:hover { background: var(--acid-strong); border-color: var(--acid-strong); color: var(--button-ink); }
    .button-secondary { color: var(--ink); border-color: var(--line); background: transparent; }
    .button-secondary:hover { background: var(--surface-raised); color: var(--ink); border-color: var(--ink-soft); }
    .button-danger { color: var(--danger); background: transparent; border-color: var(--line); }
    .button-danger:hover { background: var(--danger-bg); border-color: var(--danger); color: var(--danger); }
    .link-button, .link-button:hover { background: transparent; color: var(--ink-soft); border: 0; }
    button:disabled { opacity: .5; cursor: not-allowed; transform: none; }
    .notice { border-radius: var(--radius-sm); }
    .danger-zone { margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--line); }
    .danger-zone .notice { margin-top: var(--space-2); }
    .dashboard-intro { background: transparent; padding: 0 0 var(--space-4); border: 0; }
    .dashboard-intro h1 { margin-top: 8px; }
    .dashboard-actions { display: flex; gap: 12px; flex-wrap: wrap; }
    .backup-status { border: 1px solid var(--line); border-left: 3px solid var(--success); background: var(--surface); padding: var(--space-3); }
    .backup-status h2 { font-size: 25px; color: var(--success); }
    .backup-status-disabled { border-left-color: var(--ink-soft); }
    .backup-status-disabled h2 { color: var(--ink-soft); }
    .backup-status-danger { border-left-color: var(--danger); background: var(--danger-bg); box-shadow: none; }
    .backup-status-danger h2 { color: var(--danger); }
    .backup-status-grid { margin-top: var(--space-4); }
    .work-form-panel { max-width: 100%; background: transparent; border: 0; padding: 0; }
    .form-section { background: var(--surface); border-radius: var(--radius-md); padding: clamp(20px, 3vw, 36px); margin-block: var(--space-4); }
    .form-section legend { font-size: 20px; padding-inline: 12px; }
    .section-number { color: var(--acid); margin-right: 12px; }
    .form-index { display: flex; flex-wrap: wrap; gap: 12px 24px; padding-block: 16px; border-block: 1px solid var(--line); }
    .form-index a { font-size: 13px; text-decoration: none; }
    .form-section, :target, input:invalid, textarea:invalid, select:invalid { scroll-margin-top: 112px; }
    .form-media-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); align-items: start; }
    .form-media-grid > .form-section { min-width: 0; margin-top: 0; }
    .form-section .hint { line-height: 1.8; }
    .work-update-list { display: grid; gap: var(--space-2); margin-block: var(--space-3); }
    .work-update-admin { display: flex; align-items: start; justify-content: space-between; gap: var(--space-3); padding: var(--space-2); border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--paper); }
    .work-update-admin time { color: var(--acid); font-family: var(--font-mono); font-size: 12px; }
    .work-update-admin p { margin: 8px 0 0; color: var(--ink-soft); }
    .work-update-admin form { margin: 0; flex: 0 0 auto; }
    .work-updates-admin textarea { min-height: 180px; font-family: var(--font-mono); }
    .work-update-more { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); }
    .work-update-more summary { padding: var(--space-2); color: var(--acid); cursor: pointer; font-weight: 700; }
    .work-update-more summary::marker { color: var(--acid); }
    .work-update-more[open] summary { border-bottom: 1px solid var(--line); }
    .work-update-more .work-update-admin { margin: var(--space-2); }
    .save-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); padding-block: var(--space-3); border-top: 1px solid var(--line); }
    .save-bar button { margin: 0; }
    .save-bar p { color: var(--ink-soft); font-size: 13px; }
    .short-textarea { min-height: 110px; }
    #body { font-family: var(--font-mono); min-height: 300px; }
    .upload-preview { min-width: 0; }
    .upload-preview img { max-width: 100%; }
    .gallery-grid { grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); }
    .feedback-filters .is-active { color: var(--button-ink); background: var(--acid); border-color: var(--acid); }
    .feedback-message { border-radius: var(--radius-sm); }
    .feedback-topic > header { flex-direction: row; flex-wrap: wrap; }
    .status-badge { font-size: 12px; }
    table { margin-top: var(--space-3); table-layout: fixed; }
    th, td { overflow-wrap: anywhere; }
    td:last-child a { display: inline-block; padding-block: 8px; }
    td[colspan] { padding-block: var(--space-4); color: var(--ink-soft); }
    .grid { grid-template-columns: 1fr; }
    .empty-state { padding-block: var(--space-3); line-height: 1.9; }
    dl { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px 20px; }
    dt { color: var(--ink-soft); font-size: 13px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    @media (max-width: 720px) {
      body > header { flex-direction: row; align-items: center; padding: 14px 18px; gap: 14px; }
      .nav-toggle { display: block; margin-left: auto; flex: 0 0 auto; }
      .js .admin-nav { position: absolute; top: calc(100% + 8px); right: 18px; left: 18px; visibility: hidden; opacity: 0; transform: translateY(-8px); padding: 12px; flex-direction: column; align-items: stretch; gap: 2px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--paper); box-shadow: 0 22px 60px rgba(0, 0, 0, .3); transition: opacity 200ms var(--ease), transform 200ms var(--ease), visibility 200ms; }
      .js .admin-nav.is-open { visibility: visible; opacity: 1; transform: translateY(0); }
      .js .admin-nav a, .js .admin-nav form, .js .admin-nav .link-button { width: 100%; }
      .js .admin-nav a, .js .admin-nav .link-button { min-height: 44px; padding: 10px 12px; justify-content: flex-start; }
      main { width: calc(100% - 36px); margin-block: 36px; }
      .narrow { margin-top: 24px; }
      .panel { padding: 22px; }
      .dashboard-intro, .work-form-panel { padding: 0; }
      .form-media-grid { grid-template-columns: 1fr; gap: 0; }
      .form-grid { grid-template-columns: 1fr; }
      .form-section { margin-block: 24px; }
      .work-update-admin { flex-direction: column; }
      .work-update-admin form, .work-update-admin button { width: 100%; }
      .backup-status-grid { grid-template-columns: 1fr; }
      table { display: table; font-size: 12px; }
      th, td { padding: 12px 4px; font-size: 12px; }
      .dashboard-actions .button { flex-grow: 1; }
      dl { grid-template-columns: 1fr; gap: 4px; }
      dd { margin-bottom: 14px; }
      .save-bar button { width: 100%; }
    }
  </style>
</head>
<body>
  <header><a class="admin-brand" href="/admin" aria-label="知了hub 管理后台"><span class="brand-mark" aria-hidden="true">知</span><span><strong>知了hub</strong><small>PERSONAL ARCHIVE / 编辑室</small></span></a>${navigation}</header>
  <main>${content}</main>
  ${authenticated ? '<script src="/admin/navigation.js" defer></script>' : ''}
</body>
</html>`;
}

function workFormScript() {
  return String.raw`(() => {
  const form = document.querySelector('[data-work-form]');
  if (!form) return;

  const uploadApi = form.dataset.uploadApi;
  const csrfToken = form.dataset.csrfToken;
  const status = form.querySelector('[data-upload-status]');
  const saveButton = form.querySelector('[data-save-work]');
  let pendingUploads = 0;
  let mainFormDirty = false;
  let hasUnsavedUpload = false;
  let allowUnload = false;

  function localUploadStatus(name) {
    return form.querySelector('[data-upload-local-status="' + name + '"]');
  }

  function setStatus(message, error = false, localStatus = null) {
    for (const target of new Set([status, localStatus].filter(Boolean))) {
      target.textContent = message;
      target.classList.toggle('error', error);
    }
  }

  function setPending(delta) {
    pendingUploads += delta;
    saveButton.disabled = pendingUploads > 0;
  }

  function mainFormHasUnsavedChanges() {
    return mainFormDirty || hasUnsavedUpload || pendingUploads > 0;
  }

  function markMainFormDirty() {
    mainFormDirty = true;
  }

  function setUpdateActionStatus(actionForm, message) {
    const actionStatus = actionForm.querySelector('[data-work-update-status]');
    if (!actionStatus) return;
    actionStatus.textContent = message;
    actionStatus.classList.add('error');
  }

  document.querySelectorAll('[data-work-update-action]').forEach((actionForm) => {
    actionForm.addEventListener('submit', (event) => {
      if (mainFormHasUnsavedChanges()) {
        event.preventDefault();
        setUpdateActionStatus(actionForm, '上方作品表单还有未保存的改动，请先点上方“保存并发布”。');
        return;
      }
      if (actionForm.matches('[data-delete-work-update]')
        && !window.confirm('确定删除这条更新记录吗？删除后将立即更新公开页面。')) {
        event.preventDefault();
      }
    });
  });

  form.addEventListener('input', markMainFormDirty);
  form.addEventListener('change', markMainFormDirty);

  window.addEventListener('beforeunload', (event) => {
    if (allowUnload || (!hasUnsavedUpload && pendingUploads === 0)) return;
    event.preventDefault();
    event.returnValue = '';
  });

  form.addEventListener('invalid', (event) => {
    const field = event.target;
    const label = field.labels && field.labels[0]
      ? field.labels[0].textContent.trim()
      : field.name || '表单字段';
    const detail = field.validationMessage || '内容不符合要求';
    setStatus('请检查“' + label + '”：' + detail + '。', true);
    field.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, true);

  async function uploadFile(file, directory, localStatus) {
    const body = new FormData();
    body.append('file', file, file.name);
    setPending(1);
    setStatus('正在上传 ' + file.name + '…', false, localStatus);
    try {
      const response = await fetch(uploadApi, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
        credentials: 'same-origin',
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '上传失败（HTTP ' + response.status + '）。');
      hasUnsavedUpload = true;
      markMainFormDirty();
      setStatus('已上传 ' + payload.originalName + ' · 保存作品后才会生效', false, localStatus);
      return {
        path: 'assets/works/' + directory + '/' + payload.storedName,
        previewUrl: '/uploads/' + encodeURIComponent(payload.storedName),
        filename: payload.storedName,
      };
    } finally {
      setPending(-1);
    }
  }

  function clearElement(element) {
    while (element.firstChild) element.firstChild.remove();
  }

  function addRemoveButton(container, attribute) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button-danger compact-button';
    button.textContent = '移除';
    button.setAttribute(attribute, '');
    container.append(button);
  }

  function renderPreview(container, result, type, label, clearAttribute) {
    clearElement(container);
    const media = document.createElement(type === 'video' ? 'video' : 'img');
    media.src = result.previewUrl;
    if (type === 'video') {
      media.controls = true;
      media.preload = 'metadata';
      media.setAttribute('aria-label', label);
    } else {
      media.alt = label;
    }
    const filename = document.createElement('span');
    filename.className = 'upload-filename';
    filename.textContent = result.filename;
    container.append(media, filename);
    addRemoveButton(container, clearAttribute);
  }

  function currentMainType() {
    return form.querySelector('input[name="mainMediaType"]:checked').value;
  }

  const coverFile = form.querySelector('#coverFile');
  const cropper = form.querySelector('[data-cropper]');
  const canvas = form.querySelector('[data-cover-canvas]');
  const cropUpload = form.querySelector('[data-upload-crop]');
  const coverValue = form.querySelector('[data-cover-value]');
  const coverPreview = form.querySelector('[data-cover-preview]');
  const coverStatus = localUploadStatus('cover');
  const context = canvas.getContext('2d');
  const cropState = {
    image: null,
    scale: 1,
    box: null,
    dragging: false,
    mode: '',
    handle: '',
    anchorX: 0,
    anchorY: 0,
    offsetX: 0,
    offsetY: 0,
    objectUrl: '',
  };

  function cropCorners() {
    const box = cropState.box;
    return {
      nw: { x: box.x, y: box.y },
      ne: { x: box.x + box.width, y: box.y },
      sw: { x: box.x, y: box.y + box.height },
      se: { x: box.x + box.width, y: box.y + box.height },
    };
  }

  function hitResizeHandle(point) {
    if (!cropState.box) return '';
    const tolerance = Math.max(16, Math.min(24, cropState.box.width * 0.05));
    for (const [name, corner] of Object.entries(cropCorners())) {
      if (Math.hypot(point.x - corner.x, point.y - corner.y) <= tolerance) return name;
    }
    return '';
  }

  function pointInsideCrop(point) {
    const box = cropState.box;
    return box && point.x >= box.x && point.x <= box.x + box.width
      && point.y >= box.y && point.y <= box.y + box.height;
  }

  function drawCropper() {
    if (!cropState.image || !cropState.box) return;
    const box = cropState.box;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(cropState.image, 0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(20, 25, 28, 0.58)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      cropState.image,
      box.x / cropState.scale,
      box.y / cropState.scale,
      box.width / cropState.scale,
      box.height / cropState.scale,
      box.x,
      box.y,
      box.width,
      box.height,
    );
    context.strokeStyle = '#eff2f3';
    context.lineWidth = 3;
    context.strokeRect(box.x + 1.5, box.y + 1.5, box.width - 3, box.height - 3);
    const handleSize = Math.max(10, Math.min(18, box.width * 0.04));
    context.fillStyle = '#eff2f3';
    for (const corner of Object.values(cropCorners())) {
      context.fillRect(corner.x - handleSize / 2, corner.y - handleSize / 2, handleSize, handleSize);
    }
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  coverFile.addEventListener('change', () => {
    const file = coverFile.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return setStatus('封面必须选择图片文件。', true, coverStatus);
    if (cropState.objectUrl) URL.revokeObjectURL(cropState.objectUrl);
    cropState.objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      cropState.image = image;
      cropState.scale = Math.min(720 / image.naturalWidth, 480 / image.naturalHeight, 1);
      canvas.width = Math.max(1, Math.round(image.naturalWidth * cropState.scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * cropState.scale));
      let width = canvas.width * 0.86;
      let height = width * 9 / 16;
      if (height > canvas.height * 0.86) {
        height = canvas.height * 0.86;
        width = height * 16 / 9;
      }
      cropState.box = {
        x: (canvas.width - width) / 2,
        y: (canvas.height - height) / 2,
        width,
        height,
      };
      cropper.hidden = false;
      drawCropper();
      setStatus('拖动选区内部调整位置，拖动四角按16:9缩放。', false, coverStatus);
    };
    image.onerror = () => setStatus('无法读取所选封面图片。', true, coverStatus);
    image.src = cropState.objectUrl;
  });

  canvas.addEventListener('pointerdown', (event) => {
    if (!cropState.box) return;
    const point = canvasPoint(event);
    const box = cropState.box;
    const handle = hitResizeHandle(point);
    if (handle) {
      cropState.mode = 'resize';
      cropState.handle = handle;
      cropState.anchorX = handle.includes('w') ? box.x + box.width : box.x;
      cropState.anchorY = handle.includes('n') ? box.y + box.height : box.y;
    } else if (pointInsideCrop(point)) {
      cropState.mode = 'move';
      cropState.offsetX = point.x - box.x;
      cropState.offsetY = point.y - box.y;
    } else return;
    cropState.dragging = true;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    const point = canvasPoint(event);
    if (!cropState.dragging) {
      const handle = hitResizeHandle(point);
      canvas.style.cursor = handle ? handle + '-resize' : pointInsideCrop(point) ? 'move' : 'default';
      return;
    }
    const box = cropState.box;
    if (cropState.mode === 'move') {
      box.x = Math.max(0, Math.min(canvas.width - box.width, point.x - cropState.offsetX));
      box.y = Math.max(0, Math.min(canvas.height - box.height, point.y - cropState.offsetY));
    } else {
      const growsRight = cropState.handle.includes('e');
      const growsDown = cropState.handle.includes('s');
      const maxWidthByX = growsRight ? canvas.width - cropState.anchorX : cropState.anchorX;
      const maxHeightByY = growsDown ? canvas.height - cropState.anchorY : cropState.anchorY;
      const maxWidth = Math.max(1, Math.min(maxWidthByX, maxHeightByY * 16 / 9));
      const minimumWidth = Math.min(120, maxWidth);
      const requestedWidth = Math.max(
        Math.abs(point.x - cropState.anchorX),
        Math.abs(point.y - cropState.anchorY) * 16 / 9,
      );
      box.width = Math.max(minimumWidth, Math.min(maxWidth, requestedWidth));
      box.height = box.width * 9 / 16;
      box.x = growsRight ? cropState.anchorX : cropState.anchorX - box.width;
      box.y = growsDown ? cropState.anchorY : cropState.anchorY - box.height;
    }
    drawCropper();
  });

  function stopDragging(event) {
    if (!cropState.dragging) return;
    cropState.dragging = false;
    cropState.mode = '';
    cropState.handle = '';
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  canvas.addEventListener('pointerup', stopDragging);
  canvas.addEventListener('pointercancel', stopDragging);

  cropUpload.addEventListener('click', async () => {
    if (!cropState.image || !cropState.box) return setStatus('请先选择封面图片。', true, coverStatus);
    const output = document.createElement('canvas');
    output.width = 1280;
    output.height = 720;
    const box = cropState.box;
    output.getContext('2d').drawImage(
      cropState.image,
      box.x / cropState.scale,
      box.y / cropState.scale,
      box.width / cropState.scale,
      box.height / cropState.scale,
      0,
      0,
      output.width,
      output.height,
    );
    const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/webp', 0.9));
    if (!blob) return setStatus('浏览器无法生成裁剪后的封面。', true, coverStatus);
    try {
      const result = await uploadFile(new File([blob], 'cover.webp', { type: 'image/webp' }), 'covers', coverStatus);
      coverValue.value = result.path;
      renderPreview(coverPreview, result, 'image', '当前作品封面', 'data-clear-cover');
    } catch (error) {
      setStatus(error.message, true, coverStatus);
    }
  });

  const mainFile = form.querySelector('#mainMediaFile');
  const mainValue = form.querySelector('[data-main-value]');
  const mainPreview = form.querySelector('[data-main-preview]');
  const mainStatus = localUploadStatus('main');
  mainFile.addEventListener('change', async () => {
    const file = mainFile.files[0];
    if (!file) return;
    const type = currentMainType();
    if (type === 'image' && !file.type.startsWith('image/')) return setStatus('当前主媒体类型是图片，请选择图片文件。', true, mainStatus);
    if (type === 'video' && !file.type.startsWith('video/')) return setStatus('当前主媒体类型是视频，请选择MP4或WebM。', true, mainStatus);
    try {
      const result = await uploadFile(file, 'main', mainStatus);
      mainValue.value = result.path;
      renderPreview(mainPreview, result, type, '当前主媒体', 'data-clear-main');
    } catch (error) {
      setStatus(error.message, true, mainStatus);
    } finally {
      mainFile.value = '';
    }
  });

  form.querySelectorAll('input[name="mainMediaType"]').forEach((radio) => radio.addEventListener('change', () => {
    if (!mainValue.value) return;
    const extension = mainValue.value.split('.').at(-1).toLowerCase();
    const isVideo = extension === 'mp4' || extension === 'webm';
    if ((currentMainType() === 'video') !== isVideo) {
      mainValue.value = '';
      clearElement(mainPreview);
      setStatus('主媒体类型已改变，请重新选择对应文件。', false, mainStatus);
    }
  }));

  const galleryFiles = form.querySelector('#galleryFiles');
  const galleryValue = form.querySelector('[data-gallery-value]');
  const galleryList = form.querySelector('[data-gallery-list]');
  const galleryStatus = localUploadStatus('gallery');
  function galleryPaths() {
    try { return JSON.parse(galleryValue.value || '[]'); } catch { return []; }
  }
  function renderGalleryItem(result, type) {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.dataset.galleryItem = '';
    item.dataset.galleryPath = result.path;
    const media = document.createElement(type === 'video' ? 'video' : 'img');
    media.src = result.previewUrl;
    if (type === 'video') {
      media.muted = true;
      media.preload = 'metadata';
      media.setAttribute('aria-label', '辅图视频 ' + result.filename);
    } else {
      media.alt = '辅图 ' + result.filename;
    }
    const name = document.createElement('span');
    name.textContent = result.filename;
    item.append(media, name);
    addRemoveButton(item, 'data-remove-gallery');
    galleryList.append(item);
  }
  galleryFiles.addEventListener('change', async () => {
    const paths = galleryPaths();
    for (const file of galleryFiles.files) {
      const type = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : '';
      if (!type) {
        setStatus('辅图只允许图片、MP4或WebM。', true, galleryStatus);
        continue;
      }
      try {
        const result = await uploadFile(file, 'gallery', galleryStatus);
        paths.push(result.path);
        galleryValue.value = JSON.stringify(paths);
        renderGalleryItem(result, type);
      } catch (error) {
        setStatus(error.message, true, galleryStatus);
      }
    }
    galleryFiles.value = '';
  });

  galleryList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-gallery]');
    if (!button) return;
    const item = button.closest('[data-gallery-item]');
    galleryValue.value = JSON.stringify(galleryPaths().filter((path) => path !== item.dataset.galleryPath));
    item.remove();
    markMainFormDirty();
  });

  const downloadUpload = form.querySelector('#downloadUpload');
  const downloadValue = form.querySelector('[data-download-value]');
  const downloadPreview = form.querySelector('[data-download-preview]');
  const downloadStatus = localUploadStatus('download');
  downloadUpload.addEventListener('change', async () => {
    const file = downloadUpload.files[0];
    if (!file) return;
    try {
      const result = await uploadFile(file, 'downloads', downloadStatus);
      downloadValue.value = result.path;
      clearElement(downloadPreview);
      const name = document.createElement('span');
      name.className = 'upload-filename';
      name.textContent = result.filename;
      downloadPreview.append(name);
      addRemoveButton(downloadPreview, 'data-clear-download');
    } catch (error) {
      setStatus(error.message, true, downloadStatus);
    } finally {
      downloadUpload.value = '';
    }
  });

  form.addEventListener('click', (event) => {
    if (event.target.closest('[data-clear-cover]')) {
      coverValue.value = '';
      clearElement(coverPreview);
      markMainFormDirty();
    }
    if (event.target.closest('[data-clear-main]')) {
      mainValue.value = '';
      clearElement(mainPreview);
      markMainFormDirty();
    }
    if (event.target.closest('[data-clear-download]')) {
      downloadValue.value = '';
      clearElement(downloadPreview);
      markMainFormDirty();
    }
  });

  form.addEventListener('submit', (event) => {
    if (pendingUploads > 0) {
      event.preventDefault();
      setStatus('请等待当前上传完成后再保存。', true);
      return;
    }
    allowUnload = true;
    hasUnsavedUpload = false;
    mainFormDirty = false;
  });
})();`;
}

function labManagementScript() {
  return `'use strict';
document.querySelectorAll('[data-copy-lab-link]').forEach((button) => {
  button.addEventListener('click', async () => {
    const input = document.getElementById(button.getAttribute('data-copy-lab-link'));
    if (!input) return;
    try {
      await navigator.clipboard.writeText(input.value);
      button.textContent = '已复制';
    } catch (_error) {
      input.focus();
      input.select();
      button.textContent = '请按 Ctrl+C';
    }
    window.setTimeout(() => { button.textContent = '复制链接'; }, 1800);
  });
});`;
}

module.exports = { adminNavigationScript, formatDateTime, escapeHtml, labManagementScript, layout, workFormScript };
