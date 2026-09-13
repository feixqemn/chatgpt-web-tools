// ==UserScript==
// @name         ChatGPT 微工具
// @namespace    https://github.com/feixqemn
// @version      0.3.2
// @description  中文 Markdown 加粗修复、页面加宽、公式双击复制、表格复制 Markdown、页面清理与链接提示词。
// @author       feixqemn
// @match        https://chatgpt.com/*
// @icon         https://chatgpt.com/favicon.ico
// @homepageURL  https://github.com/feixqemn/chatgpt-web-tools
// @updateURL    https://github.com/feixqemn/chatgpt-web-tools/releases/latest/download/chatgpt-micro-tools.user.js
// @downloadURL  https://github.com/feixqemn/chatgpt-web-tools/releases/latest/download/chatgpt-micro-tools.user.js
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      *
// @license      MIT
// ==/UserScript==

(() => {
  "use strict"

  const APP = "cmt"
  const STORE_KEY = `${APP}:state:v1`
  const GITHUB_TOKEN_KEY = `${APP}:github-token:v1`
  const MAX_REMOTE_BYTES = 1024 * 1024
  const PRIVATE_GITHUB_SOURCE = Object.freeze({
    owner: "feixqemn",
    repository: "natural-trace-skills",
    ref: "main",
    path: "natural-trace-web/SKILL.md",
    fragment: "task",
  })
  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]'
  const EDITOR_SELECTOR = [
    "#prompt-textarea",
    'textarea[data-id="root"]',
    'form[data-type="unified-composer"] [contenteditable="true"]',
  ].join(",")
  const DISCLAIMER_TEXTS = new Set([
    "ChatGPT 也可能会犯错。请核查重要信息",
    "ChatGPT can make mistakes. Check important info",
  ])

  const DEFAULT_STATE = Object.freeze({
    settings: {
      boldFix: true,
      wideMode: true,
      wideWidth: 1080,
      formulaCopy: true,
      formulaFormat: "latex",
      formulaDelimiter: true,
      tableCopy: true,
      hideDisclaimer: true,
    },
    prompts: [],
  })

  const ICONS = {
    mark: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 7h8M17 7h2M5 12h2M11 12h8M5 17h6M15 17h4"/>
        <circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="13" cy="17" r="2"/>
      </svg>`,
    plus: `
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>`,
    refresh: `
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.3 7.1A6 6 0 1 0 16 11"/><path d="M15.2 3.8v3.8h-3.8"/></svg>`,
    trash: `
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6.5h11M8 3.8h4M6.5 6.5l.6 9h5.8l.6-9M8.5 9v4M11.5 9v4"/></svg>`,
    key: `
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7.2" cy="10.2" r="3.4"/><path d="m10.1 8.4 5-5M13.2 5.3l1.6 1.6M11.7 6.8l1.5 1.5"/></svg>`,
    copy: `
      <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="9" rx="2"/><path d="M13.5 6.5V5.8a1.8 1.8 0 0 0-1.8-1.8H5.8A1.8 1.8 0 0 0 4 5.8v5.9a1.8 1.8 0 0 0 1.8 1.8h.7"/></svg>`,
    check: `
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.2 3.2 3.2 7.8-7.8"/></svg>`,
  }

  let state = normalizeState(readStoredValue(STORE_KEY, DEFAULT_STATE))
  let githubToken = readSecretValue(GITHUB_TOKEN_KEY)
  const runtime = {
    host: null,
    shadow: null,
    featureStyle: null,
    contentObserver: null,
    themeObserver: null,
    scanTimer: null,
    collapseTimer: null,
    toastTimer: null,
    panelOpen: false,
    activeTab: "features",
    promptQuery: "",
    promptImportOpen: false,
    githubAuthOpen: false,
    githubAuthBusy: false,
    busyPromptId: "",
  }

  function cloneDefaults() {
    return {
      settings: { ...DEFAULT_STATE.settings },
      prompts: [],
    }
  }

  function normalizeState(value) {
    const normalized = cloneDefaults()
    if (!value || typeof value !== "object") return normalized

    const settings = value.settings && typeof value.settings === "object" ? value.settings : {}
    normalized.settings.boldFix = booleanOr(settings.boldFix, normalized.settings.boldFix)
    normalized.settings.wideMode = booleanOr(settings.wideMode, normalized.settings.wideMode)
    normalized.settings.wideWidth = clampNumber(settings.wideWidth, 760, 1440, 1080)
    normalized.settings.formulaCopy = booleanOr(
      settings.formulaCopy,
      normalized.settings.formulaCopy,
    )
    normalized.settings.formulaFormat =
      settings.formulaFormat === "mathml" ? "mathml" : "latex"
    normalized.settings.formulaDelimiter = booleanOr(
      settings.formulaDelimiter,
      normalized.settings.formulaDelimiter,
    )
    normalized.settings.tableCopy = booleanOr(settings.tableCopy, normalized.settings.tableCopy)
    normalized.settings.hideDisclaimer = booleanOr(
      settings.hideDisclaimer,
      normalized.settings.hideDisclaimer,
    )

    if (Array.isArray(value.prompts)) {
      normalized.prompts = value.prompts
        .filter((prompt) => prompt && typeof prompt === "object")
        .map((prompt) => ({
          id: typeof prompt.id === "string" ? prompt.id : createId(),
          title: cleanTitle(prompt.title) || "未命名提示词",
          content: typeof prompt.content === "string" ? prompt.content : "",
          kind: prompt.kind === "remote" ? "remote" : "local",
          url: typeof prompt.url === "string" ? prompt.url : "",
          updatedAt: Number.isFinite(prompt.updatedAt) ? prompt.updatedAt : 0,
        }))
        .filter((prompt) => prompt.content.trim() || (prompt.kind === "remote" && prompt.url))
    }

    return normalized
  }

  function booleanOr(value, fallback) {
    return typeof value === "boolean" ? value : fallback
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.round(number)))
  }

  function cleanTitle(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 80) : ""
  }

  function createId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  }

  function readStoredValue(key, fallback) {
    try {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback)
    } catch (error) {
      console.warn(`[${APP}] 无法读取油猴存储`, error)
    }

    try {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch {
      return fallback
    }
  }

  function readSecretValue(key) {
    try {
      if (typeof GM_getValue === "function") {
        const value = GM_getValue(key, "")
        return typeof value === "string" ? value.trim() : ""
      }
    } catch (error) {
      console.warn(`[${APP}] 无法读取私有 GitHub 授权状态`, error)
    }
    return ""
  }

  function writeSecretValue(key, value) {
    if (typeof GM_setValue !== "function") {
      throw new Error("当前油猴管理器不支持隔离凭证存储")
    }
    GM_setValue(key, value)
  }

  function persistState() {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(STORE_KEY, state)
        return
      }
    } catch (error) {
      console.warn(`[${APP}] 无法写入油猴存储`, error)
    }

    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state))
    } catch (error) {
      console.warn(`[${APP}] 无法写入本地存储`, error)
    }
  }

  function init() {
    if (document.getElementById(`${APP}-host`)) return
    ensureFeatureStyle()
    mountUi()
    bindPageEvents()
    applySettings({ initial: true })
    startContentObserver()
    scheduleContentScan(0)
  }

  function ensureFeatureStyle() {
    let style = document.getElementById(`${APP}-feature-style`)
    if (!style) {
      style = document.createElement("style")
      style.id = `${APP}-feature-style`
      document.head.appendChild(style)
    }

    style.textContent = `
      html[data-${APP}-wide="true"] #thread [class*="thread-content-max-width"],
      html[data-${APP}-wide="true"] #thread [style*="--thread-content-max-width"] {
        --thread-content-max-width: min(var(--${APP}-thread-width), calc(100vw - 32px)) !important;
        width: 100% !important;
        max-width: min(var(--${APP}-thread-width), calc(100vw - 32px)) !important;
        margin-inline: auto !important;
      }

      html[data-${APP}-wide="true"] main#main form[data-type="unified-composer"] {
        width: 100% !important;
        max-width: min(var(--${APP}-thread-width), calc(100vw - 32px)) !important;
      }

      html[data-${APP}-formula="true"] ${ASSISTANT_SELECTOR} :is(.katex, .katex-display, math, [data-math], [data-latex]) {
        cursor: copy !important;
      }

      html[data-${APP}-formula="true"] ${ASSISTANT_SELECTOR} :is(.katex, .katex-display):hover {
        border-radius: 5px;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 22%, transparent);
      }

      html[data-${APP}-hide-disclaimer="true"] [data-testid="thread-disclaimer"],
      html[data-${APP}-hide-disclaimer="true"] [data-${APP}-disclaimer="true"] {
        display: none !important;
      }

      [data-${APP}-table-wrap="true"] {
        position: relative !important;
      }

      .${APP}-table-copy {
        position: absolute !important;
        top: 6px !important;
        right: 6px !important;
        z-index: 6 !important;
        display: inline-grid !important;
        place-items: center !important;
        width: 30px !important;
        height: 30px !important;
        padding: 0 !important;
        border: 1px solid var(--border-light, rgba(0, 0, 0, .09)) !important;
        border-radius: 9px !important;
        color: var(--text-secondary, #5d5d5d) !important;
        background: color-mix(in srgb, var(--main-surface-primary, #fff) 92%, transparent) !important;
        box-shadow: 0 2px 8px rgba(0, 0, 0, .08) !important;
        backdrop-filter: blur(12px) saturate(1.4) !important;
        cursor: pointer !important;
        opacity: 0 !important;
        transform: translateY(-2px) !important;
        transition: opacity .16s ease, transform .16s ease, background .16s ease !important;
      }

      [data-${APP}-table-wrap="true"]:hover > .${APP}-table-copy,
      .${APP}-table-copy:focus-visible {
        opacity: 1 !important;
        transform: translateY(0) !important;
      }

      .${APP}-table-copy:hover {
        color: var(--text-primary, #171717) !important;
        background: var(--main-surface-primary, #fff) !important;
      }

      .${APP}-table-copy svg {
        width: 16px !important;
        height: 16px !important;
        fill: none !important;
        stroke: currentColor !important;
        stroke-width: 1.6 !important;
        stroke-linecap: round !important;
        stroke-linejoin: round !important;
      }

      @media (max-width: 700px) {
        html[data-${APP}-wide="true"] #thread [class*="thread-content-max-width"],
        html[data-${APP}-wide="true"] #thread [style*="--thread-content-max-width"],
        html[data-${APP}-wide="true"] main#main form[data-type="unified-composer"] {
          max-width: calc(100vw - 16px) !important;
        }
      }

      @media (hover: none) {
        .${APP}-table-copy {
          opacity: .86 !important;
          transform: none !important;
        }
      }
    `
    runtime.featureStyle = style
  }

  function mountUi() {
    const host = document.createElement("div")
    host.id = `${APP}-host`
    host.dataset.theme = pageIsDark() ? "dark" : "light"
    const shadow = host.attachShadow({ mode: "open" })

    shadow.innerHTML = `
      <style>${uiCss()}</style>
      <div class="shell" data-open="false">
        <div class="toast" role="status" aria-live="polite"></div>

        <section class="panel" aria-label="ChatGPT Web Tools" aria-hidden="true">
          <header class="panel-header">
            <div class="brand-mark">${ICONS.mark}</div>
            <div class="brand-copy">
              <strong>ChatGPT Web Tools</strong>
            </div>
            <button class="icon-button close-button" type="button" data-action="close" aria-label="收起面板">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg>
            </button>
          </header>

          <nav class="tabs" aria-label="面板分类">
            <button type="button" role="tab" aria-selected="true" data-tab="features">功能</button>
            <button type="button" role="tab" aria-selected="false" data-tab="prompts">提示词</button>
          </nav>

          <div class="view features-view" data-view="features">
            <div class="settings-list">
              ${featureRow("boldFix", "中文加粗修复", "补回响应里未渲染的 **加粗**")}
              ${featureRow("wideMode", "页面加宽", "同时调整对话与输入框")}
              <div class="sub-control width-control">
                <span>内容宽度</span>
                <input type="range" min="760" max="1440" step="20" data-setting-range="wideWidth" aria-label="聊天内容宽度">
                <output data-width-output></output>
              </div>
              ${featureRow("formulaCopy", "双击复制公式", "从 KaTeX 读取公式源码")}
              <div class="sub-control formula-control">
                <span>复制格式</span>
                <div class="choice" aria-label="公式复制格式">
                  <button type="button" data-formula-format="latex">LaTeX</button>
                  <button type="button" data-formula-format="mathml">MathML</button>
                </div>
              </div>
              ${featureRow("formulaDelimiter", "自动添加分隔符", "行内用 $，独立公式用 $$", true)}
              ${featureRow("tableCopy", "表格复制 Markdown", "在表格右上角显示复制按钮")}
              ${featureRow("hideDisclaimer", "隐藏核查提示", "移除输入框下方的免责声明")}
            </div>
          </div>

          <div class="view prompts-view" data-view="prompts" hidden>
            <div class="prompt-toolbar">
              <label class="search-box">
                <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.8" cy="8.8" r="4.8"/><path d="m12.5 12.5 3.4 3.4"/></svg>
                <input type="search" data-prompt-search placeholder="搜索提示词" autocomplete="off">
              </label>
              <button class="auth-button" type="button" data-action="toggle-github-auth" aria-label="设置私有 GitHub 授权" title="私有 GitHub">
                ${ICONS.key}<i data-github-auth-dot></i>
              </button>
              <button class="add-button" type="button" data-action="toggle-import">${ICONS.plus}<span>导入</span></button>
            </div>

            <form class="github-auth-form" data-github-auth-form hidden>
              <div class="auth-heading">
                <div><strong>私有 GitHub</strong><span data-github-auth-status></span></div>
                <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">创建只读 Token</a>
              </div>
              <div class="token-row">
                <input type="password" name="token" placeholder="github_pat_…" autocomplete="off" spellcheck="false" aria-label="GitHub Fine-grained Token">
                <button type="submit" class="primary-button">保存并验证</button>
              </div>
              <div class="auth-footer">
                <p>仅用于读取 <b>natural-trace-web/SKILL.md#task</b>，只发送给 GitHub API。</p>
                <button type="button" data-action="clear-github-auth">移除授权</button>
              </div>
            </form>

            <form class="import-form" data-import-form hidden>
              <input class="title-input" name="title" maxlength="80" placeholder="名称（可选）" autocomplete="off">
              <textarea name="source" rows="4" required placeholder="粘贴提示词正文，或 GitHub 文本链接…"></textarea>
              <p>支持 GitHub blob/raw 链接；带 #锚点时只取该章节。私有 natural-trace 来源强制使用 #task。</p>
              <div class="form-actions">
                <button type="button" class="quiet-button" data-action="cancel-import">取消</button>
                <button type="submit" class="primary-button">导入提示词</button>
              </div>
            </form>

            <div class="prompt-list" data-prompt-list></div>
          </div>
        </section>

        <button class="launcher" type="button" data-action="toggle-panel" aria-label="打开 ChatGPT Web Tools" aria-expanded="false">
          ${ICONS.mark}
        </button>
      </div>
    `

    document.body.appendChild(host)
    runtime.host = host
    runtime.shadow = shadow
    bindUiEvents()
    renderUi()
    startThemeSync()
  }

  function featureRow(key, title, description, nested = false) {
    return `
      <div class="setting-row${nested ? " nested-setting" : ""}" data-setting-row="${key}">
        <div class="setting-copy"><strong>${title}</strong><span>${description}</span></div>
        <button class="switch" type="button" role="switch" aria-checked="false" data-setting-toggle="${key}" aria-label="${title}"><i></i></button>
      </div>
    `
  }

  function uiCss() {
    return `
      :host {
        --ui-bg: rgba(255, 255, 255, .94);
        --ui-surface: #f4f4f4;
        --ui-surface-hover: #ebebeb;
        --ui-text: #191919;
        --ui-secondary: #707070;
        --ui-tertiary: #9a9a9a;
        --ui-border: rgba(0, 0, 0, .09);
        --ui-accent: #111;
        --ui-accent-text: #fff;
        --ui-danger: #d92d20;
        --panel-width: min(356px, calc(100vw - 28px));
        --panel-height: 544px;
        all: initial;
        color-scheme: light;
        position: fixed;
        right: 22px;
        bottom: 22px;
        z-index: 2147483000;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        font-size: 14px;
        line-height: 1.4;
        -webkit-font-smoothing: antialiased;
      }

      :host([data-theme="dark"]) {
        --ui-bg: rgba(36, 36, 36, .94);
        --ui-surface: #303030;
        --ui-surface-hover: #3a3a3a;
        --ui-text: #f4f4f4;
        --ui-secondary: #aaa;
        --ui-tertiary: #7f7f7f;
        --ui-border: rgba(255, 255, 255, .11);
        --ui-accent: #f4f4f4;
        --ui-accent-text: #171717;
        --ui-danger: #ff746c;
        color-scheme: dark;
      }

      *, *::before, *::after { box-sizing: border-box; }
      button, input, textarea { font: inherit; }
      button { color: inherit; }
      [hidden] { display: none !important; }

      .shell { position: relative; width: 42px; height: 42px; }

      .launcher {
        position: absolute;
        right: 0;
        bottom: 0;
        display: grid;
        place-items: center;
        width: 42px;
        height: 42px;
        padding: 0;
        border: 1px solid var(--ui-border);
        border-radius: 14px;
        color: var(--ui-text);
        background: var(--ui-bg);
        box-shadow: 0 8px 24px rgba(0, 0, 0, .14), 0 1px 2px rgba(0, 0, 0, .08);
        backdrop-filter: blur(18px) saturate(1.35);
        cursor: pointer;
        transition: transform .18s ease, background .18s ease, box-shadow .18s ease;
      }

      .launcher:hover { transform: translateY(-2px); background: var(--ui-surface); }
      .launcher:active { transform: scale(.96); }
      .launcher:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--ui-text) 48%, transparent);
        outline-offset: 2px;
      }
      .launcher svg, .brand-mark svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.55; stroke-linecap: round; stroke-linejoin: round; }
      .launcher svg circle, .brand-mark svg circle { fill: var(--ui-bg); }

      .panel {
        position: absolute;
        right: 0;
        bottom: 54px;
        display: flex;
        width: var(--panel-width);
        height: min(var(--panel-height), calc(100vh - 92px));
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--ui-border);
        border-radius: 20px;
        color: var(--ui-text);
        background: var(--ui-bg);
        box-shadow: 0 22px 60px rgba(0, 0, 0, .20), 0 2px 7px rgba(0, 0, 0, .08);
        backdrop-filter: blur(24px) saturate(1.45);
        opacity: 0;
        visibility: hidden;
        transform: translateY(10px) scale(.97);
        transform-origin: bottom right;
        transition: opacity .18s ease, transform .2s cubic-bezier(.2,.8,.2,1), visibility .18s;
      }

      .shell[data-open="true"] .panel { opacity: 1; visibility: visible; transform: none; }

      .panel-header { display: flex; flex: 0 0 auto; align-items: center; min-height: 66px; padding: 14px 14px 10px 16px; }
      .brand-mark { display: grid; place-items: center; width: 34px; height: 34px; margin-right: 10px; border-radius: 11px; color: var(--ui-accent-text); background: var(--ui-accent); }
      .brand-mark svg { width: 19px; height: 19px; }
      .brand-mark svg circle { fill: var(--ui-accent); }
      .brand-copy { display: flex; flex: 1; min-width: 0; align-items: center; }
      .brand-copy strong { font-size: 14px; font-weight: 640; letter-spacing: -.01em; }

      .icon-button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 10px; background: transparent; cursor: pointer; }
      .icon-button:hover { background: var(--ui-surface); }
      .icon-button svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }

      .tabs { display: grid; flex: 0 0 auto; grid-template-columns: 1fr 1fr; gap: 3px; margin: 0 14px 10px; padding: 3px; border-radius: 11px; background: var(--ui-surface); }
      .tabs button { height: 30px; padding: 0 12px; border: 0; border-radius: 8px; color: var(--ui-secondary); background: transparent; font-size: 12.5px; font-weight: 560; cursor: pointer; transition: color .16s ease, background .16s ease, box-shadow .16s ease; }
      .tabs button[aria-selected="true"] { color: var(--ui-text); background: var(--ui-bg); box-shadow: 0 1px 3px rgba(0,0,0,.09); }

      .view { flex: 1 1 auto; min-height: 0; overflow: hidden; }
      .features-view { flex: 0 0 auto; }
      .settings-list { border-top: 1px solid var(--ui-border); }
      .setting-row { display: flex; align-items: center; min-height: 59px; padding: 10px 16px; border-bottom: 1px solid var(--ui-border); }
      .setting-row.nested-setting { min-height: 52px; padding-left: 28px; }
      .setting-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; padding-right: 14px; }
      .setting-copy strong { font-size: 13px; font-weight: 590; letter-spacing: -.005em; }
      .setting-copy span { margin-top: 2px; color: var(--ui-secondary); font-size: 11.5px; line-height: 1.35; }

      .switch { position: relative; flex: 0 0 auto; width: 38px; height: 22px; padding: 0; border: 0; border-radius: 999px; background: #b9b9b9; cursor: pointer; transition: background .18s ease, opacity .18s ease; }
      .switch i { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.28); transition: transform .2s cubic-bezier(.2,.8,.2,1); }
      .switch[aria-checked="true"] { background: #10a37f; }
      .switch[aria-checked="true"] i { transform: translateX(16px); }
      .switch:disabled { opacity: .34; cursor: default; }

      .sub-control { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; min-height: 42px; padding: 6px 16px 8px 28px; border-bottom: 1px solid var(--ui-border); color: var(--ui-secondary); font-size: 11.5px; }
      .sub-control[aria-disabled="true"] { opacity: .42; }
      input[type="range"] { width: 100%; height: 16px; margin: 0; accent-color: #10a37f; }
      output { min-width: 45px; color: var(--ui-text); text-align: right; font-variant-numeric: tabular-nums; }
      .choice { display: grid; grid-template-columns: 1fr 1fr; grid-column: 2 / 4; gap: 2px; padding: 2px; border-radius: 9px; background: var(--ui-surface); }
      .choice button { height: 26px; padding: 0 12px; border: 0; border-radius: 7px; color: var(--ui-secondary); background: transparent; font-size: 11.5px; cursor: pointer; }
      .choice button[aria-pressed="true"] { color: var(--ui-text); background: var(--ui-bg); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
      .choice button:disabled { opacity: .45; cursor: default; }

      .prompts-view { display: flex; flex-direction: column; }
      .prompt-toolbar { display: flex; flex: 0 0 auto; gap: 8px; padding: 2px 14px 12px; }
      .search-box { display: flex; flex: 1; align-items: center; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid transparent; border-radius: 10px; background: var(--ui-surface); }
      .search-box:focus-within { border-color: var(--ui-border); background: var(--ui-bg); }
      .search-box svg { flex: 0 0 auto; width: 15px; height: 15px; margin-right: 7px; fill: none; stroke: var(--ui-secondary); stroke-width: 1.6; stroke-linecap: round; }
      .search-box input { width: 100%; min-width: 0; padding: 0; border: 0; outline: 0; color: var(--ui-text); background: transparent; font-size: 12px; }
      .search-box input::placeholder { color: var(--ui-tertiary); }
      .auth-button { position: relative; display: grid; place-items: center; flex: 0 0 auto; width: 34px; height: 34px; padding: 0; border: 1px solid var(--ui-border); border-radius: 10px; color: var(--ui-secondary); background: transparent; cursor: pointer; }
      .auth-button:hover, .auth-button[aria-pressed="true"] { color: var(--ui-text); background: var(--ui-surface); }
      .auth-button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.55; stroke-linecap: round; stroke-linejoin: round; }
      .auth-button i { position: absolute; right: 4px; bottom: 4px; width: 6px; height: 6px; border: 1.5px solid var(--ui-bg); border-radius: 50%; background: var(--ui-tertiary); }
      .auth-button[data-authorized="true"] i { background: #10a37f; }
      .add-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 34px; padding: 0 11px; border: 0; border-radius: 10px; color: var(--ui-accent-text); background: var(--ui-accent); font-size: 11.5px; font-weight: 580; cursor: pointer; }
      .add-button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }

      .github-auth-form, .import-form { flex: 0 0 auto; margin: 0 14px 12px; padding: 12px; border: 1px solid var(--ui-border); border-radius: 14px; background: color-mix(in srgb, var(--ui-surface) 62%, transparent); }
      .auth-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
      .auth-heading > div { display: flex; min-width: 0; flex-direction: column; }
      .auth-heading strong { font-size: 12.5px; font-weight: 620; }
      .auth-heading span { margin-top: 2px; color: var(--ui-secondary); font-size: 10.5px; }
      .auth-heading a { flex: 0 0 auto; color: #10a37f; font-size: 10.5px; text-decoration: none; }
      .auth-heading a:hover { text-decoration: underline; }
      .token-row { display: flex; gap: 7px; }
      .token-row input { flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--ui-border); border-radius: 9px; outline: 0; color: var(--ui-text); background: var(--ui-bg); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .token-row input:focus { border-color: color-mix(in srgb, var(--ui-text) 35%, transparent); }
      .token-row input::placeholder { color: var(--ui-tertiary); }
      .token-row .primary-button { flex: 0 0 auto; height: 34px; }
      .auth-footer { display: flex; align-items: flex-end; gap: 10px; margin-top: 8px; }
      .auth-footer p { flex: 1; margin: 0; color: var(--ui-secondary); font-size: 10px; line-height: 1.4; }
      .auth-footer b { font-weight: 580; }
      .auth-footer button { flex: 0 0 auto; padding: 0; border: 0; color: var(--ui-danger); background: transparent; font-size: 10.5px; cursor: pointer; }
      .auth-footer button[hidden] { display: none !important; }

      .import-form input, .import-form textarea { display: block; width: 100%; border: 1px solid var(--ui-border); border-radius: 9px; outline: 0; color: var(--ui-text); background: var(--ui-bg); font-size: 12px; transition: border-color .15s ease; }
      .import-form input:focus, .import-form textarea:focus { border-color: color-mix(in srgb, var(--ui-text) 35%, transparent); }
      .import-form input { height: 34px; padding: 0 10px; margin-bottom: 7px; }
      .import-form textarea { min-height: 84px; padding: 9px 10px; resize: none; line-height: 1.5; }
      .import-form input::placeholder, .import-form textarea::placeholder { color: var(--ui-tertiary); }
      .import-form p { margin: 7px 2px 10px; color: var(--ui-secondary); font-size: 10.5px; line-height: 1.45; }
      .form-actions { display: flex; justify-content: flex-end; gap: 7px; }
      .quiet-button, .primary-button { height: 30px; padding: 0 11px; border: 0; border-radius: 9px; font-size: 11.5px; font-weight: 560; cursor: pointer; }
      .quiet-button { color: var(--ui-secondary); background: transparent; }
      .quiet-button:hover { background: var(--ui-surface-hover); }
      .primary-button { color: var(--ui-accent-text); background: var(--ui-accent); }
      .primary-button:disabled { opacity: .5; cursor: wait; }

      .prompt-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--ui-border); scrollbar-width: thin; }
      .prompt-item { position: relative; display: flex; align-items: stretch; min-height: 62px; border-bottom: 1px solid var(--ui-border); }
      .prompt-main { display: flex; flex: 1; min-width: 0; flex-direction: column; justify-content: center; padding: 10px 8px 10px 16px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
      .prompt-item:hover { background: color-mix(in srgb, var(--ui-surface) 70%, transparent); }
      .prompt-main strong { overflow: hidden; font-size: 12.5px; font-weight: 590; text-overflow: ellipsis; white-space: nowrap; }
      .prompt-main span { display: block; overflow: hidden; margin-top: 3px; color: var(--ui-secondary); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
      .prompt-actions { display: flex; align-items: center; gap: 1px; padding-right: 9px; }
      .prompt-action { display: grid; place-items: center; width: 29px; height: 29px; padding: 0; border: 0; border-radius: 8px; color: var(--ui-secondary); background: transparent; cursor: pointer; opacity: 0; transition: opacity .15s ease, color .15s ease, background .15s ease; }
      .prompt-item:hover .prompt-action, .prompt-action:focus-visible { opacity: 1; }
      .prompt-action:hover { color: var(--ui-text); background: var(--ui-surface-hover); }
      .prompt-action[data-action="delete-prompt"]:hover { color: var(--ui-danger); }
      .prompt-action svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.55; stroke-linecap: round; stroke-linejoin: round; }
      .prompt-action[disabled] { opacity: .5; cursor: wait; }
      .prompt-action[disabled] svg { animation: spin .8s linear infinite; }

      .empty { padding: 42px 24px 46px; color: var(--ui-secondary); text-align: center; }
      .empty strong { display: block; margin-bottom: 5px; color: var(--ui-text); font-size: 13px; font-weight: 590; }
      .empty span { font-size: 11px; line-height: 1.5; }

      .toast { position: absolute; right: 0; bottom: 54px; width: var(--panel-width); padding: 9px 12px; border: 1px solid var(--ui-border); border-radius: 11px; color: var(--ui-text); background: var(--ui-bg); box-shadow: 0 8px 28px rgba(0,0,0,.16); backdrop-filter: blur(18px); font-size: 11.5px; font-weight: 520; opacity: 0; visibility: hidden; transform: translateY(7px); transition: opacity .16s ease, transform .16s ease, visibility .16s; pointer-events: none; }
      .toast[data-show="true"] { opacity: 1; visibility: visible; transform: none; }
      .shell[data-open="true"] .toast { right: 0; bottom: 66px; z-index: 5; }

      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
      @media (max-width: 520px) {
        :host { --panel-width: calc(100vw - 20px); right: 10px; bottom: 12px; }
        .panel { height: min(var(--panel-height), calc(100vh - 84px)); }
      }
      @media (hover: none) { .prompt-action { opacity: .76; } }
    `
  }

  function bindUiEvents() {
    const { shadow, host } = runtime
    if (!shadow || !host) return

    shadow.addEventListener("click", onUiClick)
    shadow.addEventListener("input", onUiInput)
    shadow.addEventListener("submit", onUiSubmit)
    host.addEventListener("pointerenter", cancelAutoCollapse)
    host.addEventListener("pointerleave", scheduleAutoCollapse)
    host.addEventListener("focusin", cancelAutoCollapse)
    host.addEventListener("focusout", () => {
      setTimeout(() => {
        if (!shadow.activeElement) scheduleAutoCollapse()
      }, 0)
    })
  }

  function bindPageEvents() {
    document.addEventListener("dblclick", onFormulaDoubleClick, true)
    document.addEventListener("pointerdown", (event) => {
      if (!runtime.panelOpen || event.composedPath().includes(runtime.host)) return
      setPanelOpen(false)
    })
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && runtime.panelOpen) setPanelOpen(false)
    })
  }

  function onUiClick(event) {
    const button = event.target.closest("button")
    if (!button) return

    const action = button.dataset.action
    if (action === "toggle-panel") return setPanelOpen(!runtime.panelOpen)
    if (action === "close") return setPanelOpen(false)
    if (action === "toggle-import") {
      runtime.promptImportOpen = !runtime.promptImportOpen
      if (runtime.promptImportOpen) runtime.githubAuthOpen = false
      renderPromptImport()
      renderGithubAuth()
      if (runtime.promptImportOpen) {
        runtime.shadow.querySelector('[name="source"]')?.focus()
      }
      return
    }
    if (action === "toggle-github-auth") {
      runtime.githubAuthOpen = !runtime.githubAuthOpen
      if (runtime.githubAuthOpen) runtime.promptImportOpen = false
      renderGithubAuth()
      renderPromptImport()
      if (runtime.githubAuthOpen) {
        runtime.shadow.querySelector('[data-github-auth-form] [name="token"]')?.focus()
      }
      return
    }
    if (action === "clear-github-auth") return clearGithubAuth()
    if (action === "cancel-import") {
      runtime.promptImportOpen = false
      renderPromptImport()
      return
    }
    if (action === "use-prompt") return usePrompt(button.dataset.promptId)
    if (action === "refresh-prompt") return refreshPromptFromUi(button.dataset.promptId)
    if (action === "delete-prompt") return deletePrompt(button.dataset.promptId)

    if (button.dataset.tab) {
      runtime.activeTab = button.dataset.tab
      renderTabs()
      return
    }

    if (button.dataset.settingToggle) {
      toggleSetting(button.dataset.settingToggle)
      return
    }

    if (button.dataset.formulaFormat) {
      state.settings.formulaFormat = button.dataset.formulaFormat === "mathml" ? "mathml" : "latex"
      persistState()
      applySettings()
    }
  }

  function onUiInput(event) {
    const target = event.target
    if (target.matches("[data-setting-range='wideWidth']")) {
      state.settings.wideWidth = clampNumber(target.value, 760, 1440, 1080)
      persistState()
      applySettings()
      return
    }

    if (target.matches("[data-prompt-search]")) {
      runtime.promptQuery = target.value
      renderPromptList()
    }
  }

  async function onUiSubmit(event) {
    if (event.target.matches("[data-github-auth-form]")) {
      event.preventDefault()
      await saveGithubAuth(event.target)
      return
    }
    if (event.target.matches("[data-import-form]")) {
      event.preventDefault()
      await importPromptFromForm(event.target)
    }
  }

  function setPanelOpen(open) {
    runtime.panelOpen = Boolean(open)
    cancelAutoCollapse()
    const shell = runtime.shadow?.querySelector(".shell")
    const panel = runtime.shadow?.querySelector(".panel")
    const launcher = runtime.shadow?.querySelector(".launcher")
    if (!shell || !panel || !launcher) return

    shell.dataset.open = String(runtime.panelOpen)
    panel.setAttribute("aria-hidden", String(!runtime.panelOpen))
    launcher.setAttribute("aria-expanded", String(runtime.panelOpen))
    launcher.setAttribute("aria-label", runtime.panelOpen ? "收起 ChatGPT Web Tools" : "打开 ChatGPT Web Tools")
  }

  function scheduleAutoCollapse() {
    cancelAutoCollapse()
    if (!runtime.panelOpen) return
    runtime.collapseTimer = window.setTimeout(() => {
      if (!runtime.shadow?.activeElement) setPanelOpen(false)
    }, 900)
  }

  function cancelAutoCollapse() {
    if (runtime.collapseTimer) window.clearTimeout(runtime.collapseTimer)
    runtime.collapseTimer = null
  }

  function renderUi() {
    renderTabs()
    renderSettings()
    renderGithubAuth()
    renderPromptImport()
    renderPromptList()
  }

  function renderTabs() {
    if (!runtime.shadow) return
    runtime.shadow.querySelectorAll("[data-tab]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.tab === runtime.activeTab))
    })
    runtime.shadow.querySelectorAll("[data-view]").forEach((view) => {
      view.hidden = view.dataset.view !== runtime.activeTab
    })
  }

  function renderSettings() {
    if (!runtime.shadow) return
    runtime.shadow.querySelectorAll("[data-setting-toggle]").forEach((button) => {
      const key = button.dataset.settingToggle
      button.setAttribute("aria-checked", String(Boolean(state.settings[key])))
    })

    const range = runtime.shadow.querySelector("[data-setting-range='wideWidth']")
    const widthOutput = runtime.shadow.querySelector("[data-width-output]")
    const widthControl = runtime.shadow.querySelector(".width-control")
    if (range && widthOutput && widthControl) {
      range.value = String(state.settings.wideWidth)
      range.disabled = !state.settings.wideMode
      widthOutput.textContent = `${state.settings.wideWidth}px`
      widthControl.setAttribute("aria-disabled", String(!state.settings.wideMode))
    }

    runtime.shadow.querySelectorAll("[data-formula-format]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.formulaFormat === state.settings.formulaFormat),
      )
      button.disabled = !state.settings.formulaCopy
    })

    const formulaControl = runtime.shadow.querySelector(".formula-control")
    if (formulaControl) {
      formulaControl.setAttribute("aria-disabled", String(!state.settings.formulaCopy))
    }

    const delimiterToggle = runtime.shadow.querySelector(
      "[data-setting-toggle='formulaDelimiter']",
    )
    const delimiterRow = runtime.shadow.querySelector("[data-setting-row='formulaDelimiter']")
    const delimiterDisabled =
      !state.settings.formulaCopy || state.settings.formulaFormat !== "latex"
    if (delimiterToggle) delimiterToggle.disabled = delimiterDisabled
    if (delimiterRow) delimiterRow.style.opacity = delimiterDisabled ? ".46" : ""
  }

  function renderPromptImport() {
    const form = runtime.shadow?.querySelector("[data-import-form]")
    if (form) form.hidden = !runtime.promptImportOpen
  }

  function renderGithubAuth() {
    const form = runtime.shadow?.querySelector("[data-github-auth-form]")
    const button = runtime.shadow?.querySelector("[data-action='toggle-github-auth']")
    const status = runtime.shadow?.querySelector("[data-github-auth-status]")
    const clearButton = runtime.shadow?.querySelector("[data-action='clear-github-auth']")
    if (!form || !button || !status || !clearButton) return

    form.hidden = !runtime.githubAuthOpen
    button.setAttribute("aria-pressed", String(runtime.githubAuthOpen))
    button.dataset.authorized = String(Boolean(githubToken))
    status.textContent = githubToken
      ? `已保存 · 尾号 ${githubToken.slice(-4)}`
      : "未授权"
    clearButton.hidden = !githubToken
  }

  function renderPromptList() {
    const list = runtime.shadow?.querySelector("[data-prompt-list]")
    if (!list) return
    list.replaceChildren()

    const query = runtime.promptQuery.trim().toLocaleLowerCase("zh-CN")
    const prompts = state.prompts.filter((prompt) => {
      if (!query) return true
      return `${prompt.title}\n${prompt.content}`.toLocaleLowerCase("zh-CN").includes(query)
    })

    if (!prompts.length) {
      const empty = document.createElement("div")
      empty.className = "empty"
      const title = document.createElement("strong")
      const copy = document.createElement("span")
      title.textContent = query ? "没有匹配项" : "还没有提示词"
      copy.textContent = query ? "换一个关键词试试。" : "粘贴正文，或导入一个会自动取最新内容的 GitHub 链接。"
      empty.append(title, copy)
      list.appendChild(empty)
      return
    }

    for (const prompt of prompts) {
      const item = document.createElement("div")
      item.className = "prompt-item"

      const main = document.createElement("button")
      main.type = "button"
      main.className = "prompt-main"
      main.dataset.action = "use-prompt"
      main.dataset.promptId = prompt.id
      main.disabled = runtime.busyPromptId === prompt.id

      const title = document.createElement("strong")
      title.textContent = prompt.title
      const meta = document.createElement("span")
      meta.textContent = promptMeta(prompt)
      main.append(title, meta)

      const actions = document.createElement("div")
      actions.className = "prompt-actions"
      if (prompt.kind === "remote") {
        actions.appendChild(
          promptActionButton(
            "refresh-prompt",
            prompt.id,
            ICONS.refresh,
            "立即刷新链接内容",
            runtime.busyPromptId === prompt.id,
          ),
        )
      }
      actions.appendChild(
        promptActionButton(
          "delete-prompt",
          prompt.id,
          ICONS.trash,
          "删除提示词",
          runtime.busyPromptId === prompt.id,
        ),
      )
      item.append(main, actions)
      list.appendChild(item)
    }
  }

  function promptActionButton(action, id, icon, label, disabled = false) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "prompt-action"
    button.dataset.action = action
    button.dataset.promptId = id
    button.setAttribute("aria-label", label)
    button.title = label
    button.disabled = disabled
    button.innerHTML = icon
    return button
  }

  function promptMeta(prompt) {
    const preview = prompt.content.replace(/\s+/g, " ").trim()
    if (prompt.kind !== "remote") return preview || "本地提示词"
    const time = prompt.updatedAt
      ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(prompt.updatedAt)
      : "尚未刷新"
    return `链接 · ${time}${preview ? ` · ${preview}` : ""}`
  }

  function toggleSetting(key) {
    if (!(key in state.settings)) return
    if (key === "formulaDelimiter" && state.settings.formulaFormat !== "latex") return
    state.settings[key] = !state.settings[key]
    persistState()
    applySettings()
  }

  function applySettings({ initial = false } = {}) {
    const html = document.documentElement
    html.dataset[`${APP}Wide`] = String(state.settings.wideMode)
    html.dataset[`${APP}Formula`] = String(state.settings.formulaCopy)
    html.dataset[`${APP}HideDisclaimer`] = String(state.settings.hideDisclaimer)
    html.style.setProperty(`--${APP}-thread-width`, `${state.settings.wideWidth}px`)

    if (!state.settings.boldFix && !initial) restoreFixedBold()
    if (!state.settings.tableCopy) removeTableButtons()
    renderSettings()
    scheduleContentScan(0)
  }

  function startContentObserver() {
    runtime.contentObserver?.disconnect()
    runtime.contentObserver = new MutationObserver((mutations) => {
      const relevant = mutations.some(
        (mutation) => mutation.type === "characterData" || mutation.addedNodes.length,
      )
      if (relevant) scheduleContentScan(180)
    })
    runtime.contentObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  }

  function scheduleContentScan(delay = 180) {
    if (runtime.scanTimer) window.clearTimeout(runtime.scanTimer)
    runtime.scanTimer = window.setTimeout(() => {
      runtime.scanTimer = null
      if (state.settings.boldFix) fixVisibleBold()
      if (state.settings.tableCopy) injectTableButtons()
      if (state.settings.hideDisclaimer) markDisclaimerFallback()
    }, delay)
  }

  function markDisclaimerFallback() {
    if (document.querySelector('[data-testid="thread-disclaimer"]')) return
    const thread = document.querySelector("#thread")
    if (!thread) return

    for (const candidate of thread.querySelectorAll("div")) {
      if (candidate.children.length) continue
      const text = candidate.textContent?.replace(/\s+/g, " ").trim().replace(/[。.]+$/, "")
      if (!text || !DISCLAIMER_TEXTS.has(text)) continue

      const disclaimer =
        candidate.closest('[data-testid="thread-disclaimer"], [class*="vt-disclaimer"]') ||
        candidate.parentElement
      if (disclaimer?.closest("#thread")) disclaimer.dataset[`${APP}Disclaimer`] = "true"
    }
  }

  function fixVisibleBold() {
    const messages = Array.from(document.querySelectorAll(ASSISTANT_SELECTOR))
    const lastMessage = messages.at(-1)
    const generating = isGenerating()
    const selector = ["p", "li", "blockquote", "td", "th", "figcaption"].join(",")

    for (const message of messages) {
      if (generating && message === lastMessage) continue
      for (const container of message.querySelectorAll(selector)) fixBoldInContainer(container)
    }
  }

  function isGenerating() {
    return Boolean(
      document.querySelector(
        '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="停止生成"], form[data-type="unified-composer"] button[aria-label^="Stop"]',
      ),
    )
  }

  function fixBoldInContainer(container) {
    if (container.closest("pre, code, kbd, samp, textarea, script, style, .katex, math")) return
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.includes("**")) return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        if (!parent || parent.closest("strong, b, pre, code, kbd, samp, textarea, script, style, .katex, math")) {
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      },
    })

    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    for (const node of nodes) replaceBoldMarkers(node)
  }

  function replaceBoldMarkers(textNode) {
    const text = textNode.nodeValue || ""
    const parts = splitBoldText(text)
    if (!parts) return

    const fragment = document.createDocumentFragment()
    for (const part of parts) {
      if (part.bold) {
        const strong = document.createElement("strong")
        strong.dataset[`${APP}Bold`] = "true"
        strong.textContent = part.text
        fragment.appendChild(strong)
      } else {
        fragment.appendChild(document.createTextNode(part.text))
      }
    }
    textNode.replaceWith(fragment)
  }

  function splitBoldText(text) {
    const parts = []
    let searchFrom = 0
    let plainFrom = 0
    let changed = false

    while (searchFrom < text.length) {
      const start = findUnescapedMarker(text, searchFrom)
      if (start < 0) break
      const end = findUnescapedMarker(text, start + 2)
      if (end < 0) break

      const content = text.slice(start + 2, end)
      if (
        !content ||
        /^\s|\s$/.test(content) ||
        content.startsWith("*") ||
        content.endsWith("*") ||
        content.includes("\n")
      ) {
        searchFrom = start + 2
        continue
      }

      if (start > plainFrom) parts.push({ bold: false, text: text.slice(plainFrom, start) })
      parts.push({ bold: true, text: content })
      changed = true
      plainFrom = end + 2
      searchFrom = plainFrom
    }

    if (!changed) return null
    if (plainFrom < text.length) parts.push({ bold: false, text: text.slice(plainFrom) })
    return parts
  }

  function findUnescapedMarker(text, from) {
    let index = text.indexOf("**", from)
    while (index >= 0) {
      let slashCount = 0
      for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
        slashCount += 1
      }
      if (slashCount % 2 === 0) return index
      index = text.indexOf("**", index + 2)
    }
    return -1
  }

  function restoreFixedBold() {
    document.querySelectorAll(`strong[data-${APP}-bold="true"]`).forEach((strong) => {
      strong.replaceWith(document.createTextNode(`**${strong.textContent || ""}**`))
    })
  }

  async function onFormulaDoubleClick(event) {
    if (!state.settings.formulaCopy) return
    const target = event.target instanceof Element ? event.target : event.target?.parentElement
    if (!target || target.closest(EDITOR_SELECTOR)) return

    const formula = target.closest(
      ".katex, .katex-display, math, [data-math], [data-latex], [data-custom-copy-text]",
    )
    if (!formula || !formula.closest(ASSISTANT_SELECTOR)) return

    const payload = extractFormula(formula)
    if (!payload) {
      showToast("这个公式没有可读取的源码")
      return
    }

    let copyText = ""
    if (state.settings.formulaFormat === "mathml") {
      copyText = payload.mathml
      if (!copyText) {
        showToast("这个公式没有可读取的 MathML")
        return
      }
    } else {
      if (!payload.latex) {
        showToast("这个公式没有可读取的 LaTeX")
        return
      }
      copyText = state.settings.formulaDelimiter
        ? addLatexDelimiter(payload.latex, payload.isBlock)
        : payload.latex
    }

    event.preventDefault()
    event.stopPropagation()
    try {
      await writeClipboard(copyText)
      showToast(state.settings.formulaFormat === "mathml" ? "已复制 MathML" : "已复制 LaTeX")
    } catch (error) {
      console.error(`[${APP}] 复制公式失败`, error)
      showToast("复制失败")
    }
  }

  function extractFormula(formula) {
    const katex = formula.closest(".katex") || formula.querySelector?.(".katex")
    const math = formula.matches("math")
      ? formula
      : formula.querySelector?.("math") || katex?.querySelector("math")
    const annotation =
      formula.matches('annotation[encoding="application/x-tex"]')
        ? formula
        : formula.querySelector?.('annotation[encoding="application/x-tex"]') ||
          katex?.querySelector('annotation[encoding="application/x-tex"]') ||
          math?.querySelector('annotation[encoding="application/x-tex"]')

    const rawLatex =
      formula.getAttribute("data-math") ||
      formula.getAttribute("data-latex") ||
      formula.getAttribute("data-custom-copy-text") ||
      annotation?.textContent ||
      ""
    const latex = unwrapLatexDelimiter(rawLatex)
    let mathml = ""
    if (math) {
      try {
        mathml = new XMLSerializer().serializeToString(math).trim()
      } catch {
        mathml = math.outerHTML?.trim() || ""
      }
    }

    if (!latex && !mathml) return null
    return {
      latex,
      mathml,
      isBlock: Boolean(
        formula.closest(".katex-display, .math-block") || math?.getAttribute("display") === "block",
      ),
    }
  }

  function unwrapLatexDelimiter(value) {
    const text = String(value || "").replace(/\r\n?/g, "\n").trim()
    const pairs = [
      ["$$", "$$"],
      ["\\[", "\\]"],
      ["\\(", "\\)"],
      ["$", "$"],
    ]
    for (const [open, close] of pairs) {
      if (text.startsWith(open) && text.endsWith(close) && text.length > open.length + close.length) {
        return text.slice(open.length, -close.length).trim()
      }
    }
    return text
  }

  function addLatexDelimiter(latex, isBlock) {
    const normalized = latex.replace(/\r\n?/g, "\n").trim()
    if (!isBlock) return `$${normalized}$`
    const shouldWrapLines = normalized.includes("\n") || normalized.includes("\\\\")
    return shouldWrapLines ? `$$\n${normalized}\n$$` : `$$${normalized}$$`
  }

  function injectTableButtons() {
    document.querySelectorAll(`${ASSISTANT_SELECTOR} table`).forEach((table) => {
      if (table.dataset[`${APP}Table`] === "true") return
      if (table.closest(EDITOR_SELECTOR)) return
      const wrapper = table.parentElement
      if (!wrapper) return

      wrapper.dataset[`${APP}TableWrap`] = "true"
      const button = document.createElement("button")
      button.type = "button"
      button.className = `${APP}-table-copy`
      button.dataset[`${APP}TableCopy`] = "true"
      button.title = "复制为 Markdown"
      button.setAttribute("aria-label", "复制表格为 Markdown")
      button.innerHTML = ICONS.copy
      button.addEventListener("click", async (event) => {
        event.preventDefault()
        event.stopPropagation()
        try {
          await writeClipboard(tableToMarkdown(table))
          button.innerHTML = ICONS.check
          showToast("已复制 Markdown 表格")
          window.setTimeout(() => {
            if (button.isConnected) button.innerHTML = ICONS.copy
          }, 1200)
        } catch (error) {
          console.error(`[${APP}] 复制表格失败`, error)
          showToast("复制失败")
        }
      })
      wrapper.appendChild(button)
      table.dataset[`${APP}Table`] = "true"
    })
  }

  function removeTableButtons() {
    document.querySelectorAll(`.${APP}-table-copy`).forEach((button) => button.remove())
    document.querySelectorAll(`[data-${APP}-table="true"]`).forEach((table) => {
      delete table.dataset[`${APP}Table`]
    })
    document.querySelectorAll(`[data-${APP}-table-wrap="true"]`).forEach((wrapper) => {
      delete wrapper.dataset[`${APP}TableWrap`]
    })
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.rows)
    if (!rows.length) return ""

    const matrix = rows.map((row) => {
      const values = []
      for (const cell of row.cells) {
        values.push(cellToMarkdown(cell))
        for (let index = 1; index < cell.colSpan; index += 1) values.push("")
      }
      return values
    })
    const columnCount = Math.max(...matrix.map((row) => row.length))
    for (const row of matrix) while (row.length < columnCount) row.push("")

    const headerCells = Array.from(rows[0].cells)
    const alignments = []
    for (const cell of headerCells) {
      const alignment = getComputedStyle(cell).textAlign
      const marker = alignment === "center" ? ":---:" : alignment === "right" || alignment === "end" ? "---:" : "---"
      alignments.push(marker)
      for (let index = 1; index < cell.colSpan; index += 1) alignments.push("---")
    }
    while (alignments.length < columnCount) alignments.push("---")

    const lines = [markdownTableRow(matrix[0]), markdownTableRow(alignments)]
    for (const row of matrix.slice(1)) lines.push(markdownTableRow(row))
    return lines.join("\n")
  }

  function cellToMarkdown(cell) {
    const clone = cell.cloneNode(true)
    clone.querySelectorAll(`.${APP}-table-copy, button`).forEach((node) => node.remove())
    clone.querySelectorAll(".katex-display, .katex, [data-math], [data-latex]").forEach((formula) => {
      if (formula.closest(".katex") && !formula.classList.contains("katex")) return
      const payload = extractFormula(formula)
      if (!payload?.latex) return
      formula.replaceWith(document.createTextNode(addLatexDelimiter(payload.latex, payload.isBlock)))
    })
    clone.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove())
    clone.querySelectorAll("br").forEach((br) => br.replaceWith(document.createTextNode("\n")))
    return (clone.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]*\n+[ \t]*/g, "<br>")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
      .replace(/\|/g, "\\|")
  }

  function markdownTableRow(values) {
    return `| ${values.join(" | ")} |`
  }

  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        return
      } catch {
        // 油猴授权方式作为跨浏览器回退。
      }
    }

    if (typeof GM_setClipboard === "function") {
      GM_setClipboard(text, "text")
      return
    }

    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.style.cssText = "position:fixed;left:-9999px;top:0"
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    textarea.remove()
    if (!copied) throw new Error("Clipboard API unavailable")
  }

  async function saveGithubAuth(form) {
    if (runtime.githubAuthBusy) return
    const input = form.elements.token
    const submit = form.querySelector('[type="submit"]')
    const token = input.value.trim()
    if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) {
      showToast("请粘贴 Fine-grained Token（github_pat_…）")
      return
    }

    runtime.githubAuthBusy = true
    submit.disabled = true
    submit.textContent = "正在验证…"
    try {
      const remote = parseRemoteSource(privateGithubBrowserUrl())
      await fetchRemotePrompt(remote, token)
      writeSecretValue(GITHUB_TOKEN_KEY, token)
      githubToken = token
      input.value = ""
      const importForm = runtime.shadow?.querySelector("[data-import-form]")
      const hasPendingImport = Boolean(importForm?.elements.source.value.trim())
      if (hasPendingImport) {
        runtime.githubAuthOpen = false
        runtime.promptImportOpen = true
        renderPromptImport()
      }
      renderGithubAuth()
      showToast(hasPendingImport ? "授权有效，请继续导入 #task" : "授权有效，已找到 #task")
    } catch (error) {
      console.error(`[${APP}] 验证私有 GitHub 授权失败`, error)
      showToast(error instanceof Error ? error.message : "授权验证失败")
    } finally {
      runtime.githubAuthBusy = false
      submit.disabled = false
      submit.textContent = "保存并验证"
    }
  }

  function clearGithubAuth() {
    if (runtime.githubAuthBusy) return
    try {
      writeSecretValue(GITHUB_TOKEN_KEY, "")
      githubToken = ""
      const input = runtime.shadow?.querySelector('[data-github-auth-form] [name="token"]')
      if (input) input.value = ""
      renderGithubAuth()
      showToast("私有 GitHub 授权已移除")
    } catch (error) {
      console.error(`[${APP}] 移除私有 GitHub 授权失败`, error)
      showToast(error instanceof Error ? error.message : "无法移除授权")
    }
  }

  function privateGithubBrowserUrl() {
    const source = PRIVATE_GITHUB_SOURCE
    return `https://github.com/${source.owner}/${source.repository}/blob/${source.ref}/${source.path}#${source.fragment}`
  }

  async function importPromptFromForm(form) {
    const sourceInput = form.elements.source
    const titleInput = form.elements.title
    const submit = form.querySelector('[type="submit"]')
    const source = sourceInput.value.trim()
    if (!source) return

    submit.disabled = true
    submit.textContent = "正在导入…"
    try {
      const remote = parseRemoteSource(source)
      if (remote) {
        const result = await fetchRemotePrompt(remote)
        const existing = state.prompts.find(
          (prompt) => prompt.kind === "remote" && normalizeComparableUrl(prompt.url) === normalizeComparableUrl(remote.originalUrl),
        )
        const prompt = {
          id: existing?.id || createId(),
          title: cleanTitle(titleInput.value) || existing?.title || result.suggestedTitle,
          content: result.content,
          kind: "remote",
          url: remote.originalUrl,
          updatedAt: Date.now(),
        }
        if (existing) Object.assign(existing, prompt)
        else state.prompts.unshift(prompt)
        showToast(existing ? "链接提示词已更新" : "链接提示词已导入")
      } else {
        const content = source.trim()
        state.prompts.unshift({
          id: createId(),
          title: cleanTitle(titleInput.value) || deriveLocalTitle(content),
          content,
          kind: "local",
          url: "",
          updatedAt: Date.now(),
        })
        showToast("提示词已导入")
      }

      persistState()
      form.reset()
      runtime.promptImportOpen = false
      renderPromptImport()
      renderPromptList()
    } catch (error) {
      console.error(`[${APP}] 导入提示词失败`, error)
      revealGithubAuth(error)
      showToast(error instanceof Error ? error.message : "导入失败")
    } finally {
      submit.disabled = false
      submit.textContent = "导入提示词"
    }
  }

  function parseRemoteSource(value) {
    if (/\s/.test(value)) return null
    let url
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (!/^https?:$/.test(url.protocol)) return null

    const originalUrl = url.href
    const fragment = decodeURIComponent(url.hash.slice(1))
    url.hash = ""
    let fetchUrl = url.href
    let filename = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "提示词")
    let github = null

    if (url.hostname === "github.com") {
      const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/)
      if (!match) throw new Error("请粘贴 GitHub 文件的 blob 或 raw 链接")
      const [, owner, repository, ref, path] = match
      fetchUrl = `https://raw.githubusercontent.com/${owner}/${repository}/${ref}/${path}`
      filename = decodeURIComponent(path.split("/").at(-1) || filename)
      github = {
        owner: decodeURIComponent(owner),
        repository: decodeURIComponent(repository),
        ref: decodeURIComponent(ref),
        path: decodeURIComponent(path),
      }
    } else if (url.hostname === "raw.githubusercontent.com") {
      const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
      if (match) {
        const [, owner, repository, ref, path] = match
        github = {
          owner: decodeURIComponent(owner),
          repository: decodeURIComponent(repository),
          ref: decodeURIComponent(ref),
          path: decodeURIComponent(path),
        }
      }
    }

    const privateGithub = isPrivateGithubSource(github)
    if (privateGithub && fragment.toLocaleLowerCase("en-US") !== PRIVATE_GITHUB_SOURCE.fragment) {
      throw new Error("这个私有提示词来源必须使用 #task")
    }

    return { originalUrl, fetchUrl, fragment, filename, github, privateGithub }
  }

  async function fetchRemotePrompt(remote, tokenOverride = githubToken) {
    const text = remote.privateGithub
      ? await requestPrivateGithubText(remote, tokenOverride)
      : await requestText(remote.fetchUrl)
    if (text.length > MAX_REMOTE_BYTES) throw new Error("链接内容超过 1 MB，已停止导入")
    const extracted = extractLinkedSection(text, remote.fragment)
    const content = extracted.content.trim()
    if (!content) throw new Error("链接里没有可导入的文本")

    return {
      content,
      suggestedTitle:
        cleanTitle(extracted.heading) || cleanTitle(remote.filename.replace(/\.(md|txt|markdown)$/i, "")) || "链接提示词",
    }
  }

  function isPrivateGithubSource(github) {
    if (!github) return false
    const source = PRIVATE_GITHUB_SOURCE
    return (
      github.owner.toLocaleLowerCase("en-US") === source.owner &&
      github.repository.toLocaleLowerCase("en-US") === source.repository &&
      github.ref === source.ref &&
      github.path === source.path
    )
  }

  function privateGithubApiUrl(remote) {
    const { owner, repository, ref, path } = remote.github
    const encodedPath = path.split("/").map(encodeURIComponent).join("/")
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
  }

  function requestPrivateGithubText(remote, token) {
    if (!token) {
      throw githubAuthError("这是私有仓库，请先设置 GitHub 只读 Token")
    }
    return requestText(privateGithubApiUrl(remote), {
      privateGithub: true,
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
  }

  function githubAuthError(message) {
    const error = new Error(message)
    error.githubAuthRelated = true
    return error
  }

  function revealGithubAuth(error) {
    if (!error?.githubAuthRelated) return
    runtime.activeTab = "prompts"
    runtime.githubAuthOpen = true
    runtime.promptImportOpen = false
    renderTabs()
    renderPromptImport()
    renderGithubAuth()
  }

  function requestText(url, options = {}) {
    const headers = options.headers || {
      Accept: "text/plain, text/markdown;q=0.9, */*;q=0.5",
    }
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          timeout: 15000,
          headers,
          onload(response) {
            if (response.status >= 200 && response.status < 300) resolve(response.responseText)
            else if (options.privateGithub && response.status === 401) {
              reject(githubAuthError("GitHub Token 无效或已过期"))
            } else if (options.privateGithub && response.status === 403) {
              reject(githubAuthError("Token 缺少该仓库的 Contents 读取权限"))
            } else if (options.privateGithub && response.status === 404) {
              reject(githubAuthError("Token 无权读取该私有仓库，或目标文件不存在"))
            } else if (response.status === 404) {
              reject(new Error("链接返回 404；请确认文件公开且地址正确"))
            } else {
              reject(new Error(`链接请求失败（HTTP ${response.status}）`))
            }
          },
          ontimeout() {
            reject(new Error("链接请求超时"))
          },
          onerror() {
            reject(new Error("无法读取链接内容"))
          },
        })
      })
    }

    return fetch(url, { headers }).then((response) => {
      if (!response.ok) {
        if (options.privateGithub && response.status === 401) {
          throw githubAuthError("GitHub Token 无效或已过期")
        }
        if (options.privateGithub && response.status === 403) {
          throw githubAuthError("Token 缺少该仓库的 Contents 读取权限")
        }
        if (options.privateGithub && response.status === 404) {
          throw githubAuthError("Token 无权读取该私有仓库，或目标文件不存在")
        }
        throw new Error(`链接请求失败（HTTP ${response.status}）`)
      }
      return response.text()
    })
  }

  function extractLinkedSection(text, fragment) {
    const normalized = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
    if (!fragment) return { content: normalized, heading: "" }

    const lineMatch = fragment.match(/^L(\d+)(?:-L?(\d+))?$/i)
    if (lineMatch) {
      const lines = normalized.split("\n")
      const start = Math.max(1, Number(lineMatch[1]))
      const end = Math.max(start, Number(lineMatch[2] || start))
      return { content: lines.slice(start - 1, end).join("\n"), heading: `第 ${start}${end > start ? `–${end}` : ""} 行` }
    }

    const lines = normalized.split("\n")
    const target = fragment.replace(/^#/, "").toLocaleLowerCase("en-US")
    const slugCounts = new Map()
    let startIndex = -1
    let startDepth = 0
    let heading = ""

    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/)
      if (!match) continue
      const plainHeading = stripHeadingMarkup(match[2])
      const baseSlug = githubSlug(plainHeading)
      const count = slugCounts.get(baseSlug) || 0
      slugCounts.set(baseSlug, count + 1)
      const slug = count ? `${baseSlug}-${count}` : baseSlug
      if (slug === target) {
        startIndex = index + 1
        startDepth = match[1].length
        heading = plainHeading
        break
      }
    }

    if (startIndex < 0) throw new Error(`链接中没有找到 #${fragment} 章节`)
    let endIndex = lines.length
    for (let index = startIndex; index < lines.length; index += 1) {
      const match = lines[index].match(/^(#{1,6})[ \t]+/)
      if (match && match[1].length <= startDepth) {
        endIndex = index
        break
      }
    }
    return { content: lines.slice(startIndex, endIndex).join("\n"), heading }
  }

  function stripHeadingMarkup(value) {
    return value
      .replace(/<[^>]*>/g, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .trim()
  }

  function githubSlug(value) {
    return value
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
  }

  function normalizeComparableUrl(value) {
    try {
      const url = new URL(value)
      url.hostname = url.hostname.toLowerCase()
      url.pathname = url.pathname.replace(/\/$/, "")
      return url.href
    } catch {
      return value
    }
  }

  function deriveLocalTitle(content) {
    const firstLine = content
      .split("\n")
      .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
      .find(Boolean)
    return cleanTitle(firstLine?.slice(0, 36)) || "未命名提示词"
  }

  async function usePrompt(id) {
    const prompt = state.prompts.find((item) => item.id === id)
    if (!prompt || runtime.busyPromptId) return
    runtime.busyPromptId = id
    renderPromptList()

    try {
      if (prompt.kind === "remote") await refreshPrompt(prompt)
      const inserted = insertIntoComposer(prompt.content)
      if (!inserted) throw new Error("没有找到 ChatGPT 输入框")
      showToast(prompt.kind === "remote" ? "已取最新内容并填入" : "已填入提示词")
      setPanelOpen(false)
    } catch (error) {
      console.error(`[${APP}] 使用提示词失败`, error)
      revealGithubAuth(error)
      showToast(error instanceof Error ? error.message : "无法填入提示词")
    } finally {
      runtime.busyPromptId = ""
      renderPromptList()
    }
  }

  async function refreshPromptFromUi(id) {
    const prompt = state.prompts.find((item) => item.id === id)
    if (!prompt || prompt.kind !== "remote" || runtime.busyPromptId) return
    runtime.busyPromptId = id
    renderPromptList()
    try {
      await refreshPrompt(prompt)
      showToast("链接内容已刷新")
    } catch (error) {
      console.error(`[${APP}] 刷新提示词失败`, error)
      revealGithubAuth(error)
      showToast(error instanceof Error ? error.message : "刷新失败")
    } finally {
      runtime.busyPromptId = ""
      renderPromptList()
    }
  }

  async function refreshPrompt(prompt) {
    const remote = parseRemoteSource(prompt.url)
    if (!remote) throw new Error("提示词链接无效")
    const result = await fetchRemotePrompt(remote)
    prompt.content = result.content
    prompt.updatedAt = Date.now()
    persistState()
  }

  function deletePrompt(id) {
    const index = state.prompts.findIndex((prompt) => prompt.id === id)
    if (index < 0) return
    const [removed] = state.prompts.splice(index, 1)
    persistState()
    renderPromptList()
    showToast(`已删除“${removed.title}”`)
  }

  function insertIntoComposer(content) {
    const editor = Array.from(document.querySelectorAll(EDITOR_SELECTOR)).find(isUsableEditor)
    if (!editor) return false
    editor.focus()

    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
      if (setter) setter.call(editor, content)
      else editor.value = content
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: content }))
      return true
    }

    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    selection?.removeAllRanges()
    selection?.addRange(range)

    let inserted = false
    try {
      inserted = document.execCommand("insertText", false, content)
    } catch {
      inserted = false
    }

    if (!inserted) {
      editor.textContent = content
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: content }))
    }
    editor.focus()
    return true
  }

  function isUsableEditor(editor) {
    if (!(editor instanceof HTMLElement)) return false
    if (!editor.isConnected || editor.closest(`#${APP}-host`)) return false
    const style = getComputedStyle(editor)
    if (style.display === "none" || style.visibility === "hidden") return false
    return editor.getClientRects().length > 0
  }

  function showToast(message) {
    const toast = runtime.shadow?.querySelector(".toast")
    if (!toast) return
    if (runtime.toastTimer) window.clearTimeout(runtime.toastTimer)
    toast.textContent = String(message)
    toast.dataset.show = "true"
    runtime.toastTimer = window.setTimeout(() => {
      toast.dataset.show = "false"
    }, 2400)
  }

  function startThemeSync() {
    const sync = () => {
      if (runtime.host) runtime.host.dataset.theme = pageIsDark() ? "dark" : "light"
    }
    runtime.themeObserver?.disconnect()
    runtime.themeObserver = new MutationObserver(sync)
    runtime.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    })
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", sync)
  }

  function pageIsDark() {
    const html = document.documentElement
    if (html.classList.contains("dark") || html.dataset.theme === "dark") return true
    if (html.classList.contains("light") || html.dataset.theme === "light") return false
    return window.matchMedia("(prefers-color-scheme: dark)").matches
  }

  if (document.body && document.head) init()
  else window.addEventListener("DOMContentLoaded", init, { once: true })
})()
