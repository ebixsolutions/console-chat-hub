(function () {
  if (window.__nexusChatLoaded) return;
  window.__nexusChatLoaded = true;

  var script =
    document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();

  var channelId = script.getAttribute("data-channel-id");
  var apiBase = (script.getAttribute("data-api-base") || "").replace(/\/$/, "");
  if (!channelId || !apiBase) {
    console.error("[NexusAI] data-channel-id and data-api-base are required");
    return;
  }

  var P = "nexus_widget_" + channelId;
  var SK_TOKEN = P + "_session_token";
  var SK_CONV = P + "_conversation_id";
  var SK_CHANNEL = P + "_channel_id";
  var SK_TICKETS = P + "_tickets";
  var SK_MODERN_WIDTH = P + "_modern_panel_width";

  var MODERN_DEFAULT_WIDTH = 420;
  var MODERN_MIN_WIDTH = 340;
  var MODERN_MAX_WIDTH = 720;
  var MOBILE_BREAKPOINT = 640;

  var config = null;
  var lastMessageId = null;
  var seenIds = {};
  var panel = null;
  var bubble = null;
  var msgsEl = null;
  var inputEl = null;
  var sendBtn = null;
  var tagsEl = null;
  var typingEl = null;
  var emojiPanelEl = null;
  var plusMenuEl = null;
  var modernDividerEl = null;

  var hostLayoutCaptured = false;
  var hostOriginalMarginRight = "";
  var hostOriginalTransition = "";
  var modernWidth = MODERN_DEFAULT_WIDTH;

  var state = {
    sessionToken: null,
    conversationId: null,
    pollInterval: null,
    thinkingStartTime: null,
    fallbackShownForConversation: false,
    handoffRequested: false,
    firstMessageSent: false,
    messages: [],
    online: true,
  };

  var POLL_STEPS = [2500, 5000, 10000, 20000, 30000];
  var pollStep = 0;
  var pollTimer = null;
  var pollActive = false;
  var pollGeneration = 0;
  var pollRequestSeq = 0;
  var catchUpPending = false;
  var activePollRequest = null;

  function saveSession() {
    try {
      localStorage.setItem(SK_TOKEN, state.sessionToken);
      localStorage.setItem(SK_CONV, state.conversationId);
      localStorage.setItem(SK_CHANNEL, channelId);
    } catch (e) {}
  }

  function clearSession() {
    try {
      localStorage.removeItem(SK_TOKEN);
      localStorage.removeItem(SK_CONV);
      localStorage.removeItem(SK_CHANNEL);
    } catch (e) {}
  }

  function loadSession() {
    try {
      return {
        token: localStorage.getItem(SK_TOKEN),
        convId: localStorage.getItem(SK_CONV),
        channel: localStorage.getItem(SK_CHANNEL),
      };
    } catch (e) {
      return {};
    }
  }

  function saveTicket(cid, tok) {
    try {
      var tickets = JSON.parse(localStorage.getItem(SK_TICKETS) || "[]");
      if (
        !tickets.some(function (x) {
          return x.conversation_id === cid;
        })
      ) {
        tickets.unshift({
          ticket_no: cid.substring(0, 7),
          conversation_id: cid,
          session_token: tok,
          status: "open",
          last_message: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        localStorage.setItem(SK_TICKETS, JSON.stringify(tickets.slice(0, 20)));
      }
    } catch (e) {}
  }

  function updateTicket(cid, status, msg) {
    try {
      var tickets = JSON.parse(localStorage.getItem(SK_TICKETS) || "[]");
      var idx = tickets.findIndex(function (x) {
        return x.conversation_id === cid;
      });
      if (idx >= 0) {
        if (status) tickets[idx].status = status;
        if (msg) tickets[idx].last_message = msg;
        tickets[idx].updated_at = new Date().toISOString();
        localStorage.setItem(SK_TICKETS, JSON.stringify(tickets));
      }
    } catch (e) {}
  }

  function getTickets() {
    try {
      return JSON.parse(localStorage.getItem(SK_TICKETS) || "[]");
    } catch (e) {
      return [];
    }
  }

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function getTheme() {
    var value =
      config &&
      config.widget_config &&
      typeof config.widget_config.appearance_theme === "string"
        ? config.widget_config.appearance_theme
        : "modern";
    return value === "classic" ? "classic" : "modern";
  }

  function getPrimary() {
    return (
      (config &&
        config.widget_config &&
        config.widget_config.primary_color) ||
      "#6B5CE7"
    );
  }


  function getLauncherIcon() {
    var value =
      config && config.widget_config && typeof config.widget_config.launcher_icon === "string"
        ? config.widget_config.launcher_icon
        : "chat";
    var icons = {
      chat: "💬",
      headset: "🎧",
      sparkles: "✨",
      bot: "🤖",
      mail: "✉️",
    };
    return icons[value] || icons.chat;
  }

  function getSuggested() {
    var defaults = [
      "Track my order",
      "Shipping fee and delivery?",
      "Cancel order & refund",
      "What's the return policy?",
      "Contact human support",
    ];
    if (!config || !config.widget_config) return defaults;
    var sq = config.widget_config.suggested_questions;
    return Array.isArray(sq) && sq.length > 0 ? sq : defaults;
  }

  function isOnline() {
    var cfg = config && config.widget_config;
    if (!cfg || !cfg.business_hours || !cfg.business_hours.schedule) return true;
    try {
      var tz = cfg.business_hours.timezone || "UTC";
      var now = new Date();
      var localized = now.toLocaleString("en-US", {
        timeZone: tz,
        hour12: false,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      var parts = localized.split(", ");
      var dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      var day = dayMap[parts[0]] !== undefined ? dayMap[parts[0]] : now.getDay();
      var timeParts = parts[1].split(":");
      var currentMinutes = parseInt(timeParts[0], 10) * 60 + parseInt(timeParts[1], 10);
      for (var i = 0; i < cfg.business_hours.schedule.length; i++) {
        var schedule = cfg.business_hours.schedule[i];
        if (schedule.days && schedule.days.indexOf(day) !== -1) {
          var open = schedule.open.split(":").reduce(function (h, m) {
            return parseInt(h, 10) * 60 + parseInt(m, 10);
          });
          var close = schedule.close.split(":").reduce(function (h, m) {
            return parseInt(h, 10) * 60 + parseInt(m, 10);
          });
          if (currentMinutes >= open && currentMinutes < close) return true;
        }
      }
      return false;
    } catch (e) {
      return true;
    }
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function getTicketNo() {
    return state.conversationId
      ? state.conversationId.substring(0, 7)
      : "-------";
  }

  function loadModernWidth() {
    try {
      var raw = parseInt(localStorage.getItem(SK_MODERN_WIDTH) || "", 10);
      if (Number.isFinite(raw)) modernWidth = clampModernWidth(raw);
    } catch (e) {}
  }

  function clampModernWidth(value) {
    var viewportMax = Math.floor(window.innerWidth * 0.55);
    var max = Math.max(
      MODERN_MIN_WIDTH,
      Math.min(MODERN_MAX_WIDTH, viewportMax),
    );
    return Math.max(MODERN_MIN_WIDTH, Math.min(value, max));
  }

  function saveModernWidth(value) {
    modernWidth = clampModernWidth(value);
    try {
      localStorage.setItem(SK_MODERN_WIDTH, String(modernWidth));
    } catch (e) {}
  }

  function captureHostLayout() {
    if (hostLayoutCaptured) return;
    hostLayoutCaptured = true;
    hostOriginalMarginRight = document.body.style.marginRight || "";
    hostOriginalTransition = document.body.style.transition || "";
  }

  function applyHostSplit(open) {
    if (getTheme() !== "modern" || isMobile()) {
      restoreHostSplit();
      return;
    }

    if (!open) {
      restoreHostSplit();
      return;
    }

    captureHostLayout();
    modernWidth = clampModernWidth(modernWidth);
    var computedMargin = window.getComputedStyle(document.body).marginRight || "0px";

    if (document.body.dataset.nexusAssistantAdjusted !== "true") {
      document.body.dataset.nexusAssistantBaseMargin = computedMargin;
      document.body.dataset.nexusAssistantAdjusted = "true";
    }

    var base = document.body.dataset.nexusAssistantBaseMargin || "0px";
    document.documentElement.style.setProperty(
      "--nexus-assistant-width",
      modernWidth + "px",
    );
    document.body.style.marginRight =
      "calc(" + base + " + " + modernWidth + "px)";
    document.body.style.transition = "margin-right 160ms ease";
    document.documentElement.classList.add("nexus-assistant-open");

    try {
      window.dispatchEvent(new Event("resize"));
    } catch (e) {}
  }

  function restoreHostSplit() {
    document.documentElement.classList.remove("nexus-assistant-open");
    document.documentElement.style.removeProperty("--nexus-assistant-width");
    if (hostLayoutCaptured) {
      document.body.style.marginRight = hostOriginalMarginRight;
      document.body.style.transition = hostOriginalTransition;
    } else if (document.body.dataset.nexusAssistantAdjusted === "true") {
      document.body.style.marginRight =
        document.body.dataset.nexusAssistantBaseMargin || "";
    }
    delete document.body.dataset.nexusAssistantAdjusted;
    delete document.body.dataset.nexusAssistantBaseMargin;
    try {
      window.dispatchEvent(new Event("resize"));
    } catch (e) {}
  }

  var style = document.createElement("style");
  style.textContent = [
    ".nx-root *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".nx-bubble{position:fixed;right:20px;bottom:max(20px,env(safe-area-inset-bottom));width:56px;height:56px;border-radius:9999px;border:none;color:#fff;font-size:25px;cursor:pointer;box-shadow:0 10px 25px rgba(0,0,0,.22);z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:transform .15s ease,opacity .15s ease;background:#6B5CE7}",
    ".nx-bubble:hover{transform:scale(1.05)}",
    ".nx-panel{z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;background:#fff}",
    ".nx-theme-classic .nx-panel{position:fixed;right:20px;bottom:88px;width:360px;height:560px;min-width:300px;min-height:400px;max-width:80vw;max-height:90vh;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.25);transform-origin:bottom right;animation:nxIn .18s ease-out}",
    "@keyframes nxIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}",
    ".nx-theme-modern .nx-panel{position:fixed;top:0;right:0;bottom:0;height:100dvh;width:var(--nx-panel-width,420px);min-width:340px;max-width:55vw;border-radius:0;border-left:1px solid #e6e6e6;box-shadow:-12px 0 32px rgba(15,23,42,.08);transform:translateX(100%);visibility:hidden;transition:transform .2s ease-out,visibility 0s linear .2s}",
    ".nx-theme-modern .nx-panel.nx-open{transform:translateX(0);visibility:visible;transition:transform .2s ease-out}",
    ".nx-modern-divider{position:absolute;top:0;bottom:0;left:-4px;width:8px;cursor:ew-resize;z-index:2147483647;background:transparent}",
    ".nx-modern-divider:after{content:'';position:absolute;top:0;bottom:0;left:3px;width:1px;background:#e5e7eb;transition:background .15s}",
    ".nx-modern-divider:hover:after,.nx-modern-divider.dragging:after{background:#9ca3af}",
    ".nx-header{padding:10px 14px;display:flex;align-items:center;justify-content:space-between;font-weight:600;min-height:52px;user-select:none}",
    ".nx-theme-classic .nx-header{color:#fff;cursor:grab}",
    ".nx-theme-classic .nx-header.dragging{cursor:grabbing}",
    ".nx-theme-modern .nx-header{color:#171717;background:#fff;border-bottom:1px solid #ececec;cursor:default;padding:12px 14px}",
    ".nx-header-left{display:flex;flex-direction:column;gap:2px;pointer-events:none;min-width:0}",
    ".nx-header-title{font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".nx-header-sub{font-size:11px;font-weight:400;opacity:.72;display:flex;align-items:center;gap:5px}",
    ".nx-online-dot{width:7px;height:7px;border-radius:9999px;display:inline-block;flex-shrink:0}",
    ".nx-header-actions{display:flex;align-items:center;gap:6px}",
    ".nx-header-btn{border:none;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center}",
    ".nx-theme-classic .nx-header-btn{background:rgba(255,255,255,.2);color:#fff}",
    ".nx-theme-classic .nx-header-btn:hover{background:rgba(255,255,255,.35)}",
    ".nx-theme-modern .nx-header-btn{background:#f5f5f5;color:#555}",
    ".nx-theme-modern .nx-header-btn:hover{background:#ececec;color:#111}",
    ".nx-tags{padding:10px 12px 6px;display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid #f1f1f1;background:#fff}",
    ".nx-tag{background:#f6f6f6;border:1px solid #e6e6e6;border-radius:20px;padding:5px 10px;font-size:12px;color:#374151;cursor:pointer;white-space:nowrap;transition:all .15s}",
    ".nx-tag:hover{background:#f0edff;border-color:#8b5cf6;color:#5b21b6}",
    ".nx-msgs{flex:1;overflow-y:auto;padding:14px;background:#f7f8fa;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}",
    ".nx-theme-modern .nx-msgs{background:#fff;padding:18px 16px}",
    ".nx-msg{max-width:82%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}",
    ".nx-msg.visitor{align-self:flex-end;color:#fff;border-bottom-right-radius:4px}",
    ".nx-msg.assistant,.nx-msg.ai,.nx-msg.human_agent,.nx-msg.agent,.nx-msg.system{align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
    ".nx-theme-modern .nx-msg.assistant,.nx-theme-modern .nx-msg.ai,.nx-theme-modern .nx-msg.human_agent,.nx-theme-modern .nx-msg.agent{border-color:#ededed;background:#fafafa}",
    ".nx-msg.system{background:#f9fafb;color:#6b7280;font-style:italic;font-size:13px}",
    ".nx-recalled{align-self:flex-start;font-size:13px;color:#9ca3af;font-style:italic;padding:4px 8px}",
    ".nx-typing{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;padding:10px 14px;border-radius:12px;display:flex;gap:4px}",
    ".nx-typing span{width:6px;height:6px;background:#9ca3af;border-radius:9999px;animation:nxBounce 1.2s infinite ease-in-out}",
    ".nx-typing span:nth-child(2){animation-delay:.15s}.nx-typing span:nth-child(3){animation-delay:.3s}",
    "@keyframes nxBounce{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-4px);opacity:1}}",
    ".nx-input-area{border-top:1px solid #e5e7eb;background:#fff;position:relative}",
    ".nx-theme-modern .nx-input-area{padding:8px 10px 10px;border-top:1px solid #ededed}",
    ".nx-input-row{padding:8px 10px;display:flex;gap:6px;align-items:flex-end}",
    ".nx-theme-modern .nx-input-row{padding:0;border:1px solid #d9d9d9;border-radius:14px;align-items:flex-end;box-shadow:0 1px 4px rgba(0,0,0,.04)}",
    ".nx-plus-wrap{position:relative}",
    ".nx-plus-btn{background:none;border:1px solid #e5e7eb;border-radius:8px;color:#6b7280;cursor:pointer;font-size:18px;font-weight:300;width:32px;height:36px;display:flex;align-items:center;justify-content:center;transition:all .15s}",
    ".nx-theme-modern .nx-plus-btn{border:none;margin:4px 0 4px 4px}",
    ".nx-plus-btn:hover{background:#f3f4f6;color:#374151;border-color:#9ca3af}",
    ".nx-plus-menu{position:absolute;bottom:44px;left:0;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);min-width:190px;overflow:hidden;z-index:100}",
    ".nx-plus-item{padding:10px 14px;font-size:13px;color:#374151;cursor:pointer;display:flex;align-items:center;gap:8px;white-space:nowrap}",
    ".nx-plus-item:hover{background:#f5f3ff;color:#5b21b6}",
    ".nx-plus-item.disabled{opacity:.5;cursor:not-allowed;pointer-events:none}",
    ".nx-emoji-btn{background:none;border:none;color:#9ca3af;cursor:pointer;font-size:18px;padding:4px;height:36px;width:30px;display:flex;align-items:center;justify-content:center;border-radius:6px}",
    ".nx-theme-modern .nx-emoji-btn{margin:4px 0}",
    ".nx-emoji-btn:hover{background:#f3f4f6}",
    ".nx-emoji-panel{position:absolute;bottom:52px;left:42px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:8px;display:grid;grid-template-columns:repeat(8,28px);gap:2px;z-index:100}",
    ".nx-emoji-item{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;border-radius:6px;border:none;background:none}",
    ".nx-emoji-item:hover{background:#f3f4f6}",
    ".nx-input-row textarea{flex:1;resize:none;border:1px solid #e5e7eb;border-radius:8px;padding:7px 10px;font-size:14px;outline:none;height:36px;max-height:120px;font-family:inherit;overflow-y:auto}",
    ".nx-theme-modern .nx-input-row textarea{border:none;border-radius:0;padding:10px 6px 8px;height:44px;max-height:140px;background:transparent}",
    ".nx-input-row textarea:focus{border-color:#9ca3af}",
    ".nx-send{border:none;color:#fff;padding:0 14px;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px;height:36px;min-width:56px}",
    ".nx-theme-modern .nx-send{height:34px;margin:5px 5px 5px 0;border-radius:10px;min-width:50px}",
    ".nx-send:disabled{opacity:.5;cursor:not-allowed}",
    ".nx-footer{text-align:center;padding:5px;font-size:11px;color:#c4c4c4;background:#fff;border-top:1px solid #f3f4f6}",
    ".nx-theme-modern .nx-footer{border-top:none;padding:2px 5px 7px}",
    ".nx-resolved{margin:12px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;text-align:center;font-size:13px;color:#166534}",
    ".nx-human-state{margin:2px 12px 8px;padding:9px 11px;border-radius:9px;font-size:12px;line-height:1.4;display:none}",
    ".nx-human-state.waiting{display:block;background:#fffbeb;border:1px solid #fde68a;color:#92400e}",
    ".nx-human-state.assigned{display:block;background:#f5f3ff;border:1px solid #ddd6fe;color:#6d28d9}",
    ".nx-new-chat{margin-top:10px;background:#6B5CE7;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;font-family:inherit}",
    ".nx-resize-handle{position:absolute;bottom:0;left:0;width:20px;height:20px;cursor:sw-resize;z-index:10}",
    ".nx-theme-modern .nx-resize-handle{display:none}",
    ".nx-tickets-page{position:absolute;top:0;left:0;right:0;bottom:0;background:#fff;display:flex;flex-direction:column;z-index:10;overflow:hidden}",
    ".nx-theme-classic .nx-tickets-page{border-radius:14px}",
    ".nx-tickets-header{padding:12px 14px;display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px}",
    ".nx-theme-classic .nx-tickets-header{color:#fff}",
    ".nx-theme-modern .nx-tickets-header{color:#171717;background:#fff!important;border-bottom:1px solid #ececec}",
    ".nx-tickets-back{border:none;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center}",
    ".nx-theme-classic .nx-tickets-back{background:rgba(255,255,255,.2);color:#fff}",
    ".nx-theme-modern .nx-tickets-back{background:#f5f5f5;color:#555}",
    ".nx-tickets-list{flex:1;overflow-y:auto;padding:8px}",
    ".nx-ticket-item{padding:12px;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:8px;cursor:pointer;background:#fff;transition:all .15s}",
    ".nx-ticket-item:hover{border-color:#8b5cf6;background:#faf5ff}",
    ".nx-ticket-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}",
    ".nx-ticket-no{font-size:13px;font-weight:600;color:#374151}",
    ".nx-ticket-status{font-size:11px;padding:2px 8px;border-radius:20px;font-weight:600}",
    ".nx-ticket-status.open{background:#dbeafe;color:#1d4ed8}",
    ".nx-ticket-status.resolved{background:#d1fae5;color:#065f46}",
    ".nx-ticket-status.pending,.nx-ticket-status.human_needed{background:#fef3c7;color:#92400e}",
    ".nx-ticket-preview{font-size:12px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".nx-ticket-time{font-size:11px;color:#9ca3af;margin-top:4px}",
    ".nx-tickets-empty{text-align:center;padding:40px 20px;color:#9ca3af;font-size:14px}",
    ".nx-tickets-new{margin:12px;padding:10px;background:#6B5CE7;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;width:calc(100% - 24px);font-family:inherit}",
    ".nx-citations{margin-top:6px;padding-top:6px;border-top:1px solid #f3f4f6;display:flex;flex-direction:column;gap:3px}",
    ".nx-citations-title{font-size:10px;color:#9ca3af;font-weight:600;letter-spacing:.3px}",
    ".nx-cite-item{font-size:11px;color:#6b7280;display:flex;align-items:center;gap:4px;line-height:1.3}",
    ".nx-cite-badge{font-size:9px;background:#ede9fe;color:#6366f1;padding:1px 5px;border-radius:8px;font-weight:600;flex-shrink:0}",
    ".nx-feedback-cta{display:inline-flex;margin-top:8px;padding:7px 11px;border-radius:8px;color:#fff!important;text-decoration:none;font-size:12px;font-weight:700}",
    "@media(max-width:640px){.nx-theme-modern .nx-panel{left:0!important;right:0!important;top:0!important;bottom:0!important;width:100vw!important;min-width:0!important;max-width:none!important;height:100dvh!important;border-left:none!important}.nx-theme-modern .nx-modern-divider{display:none!important}.nx-theme-modern .nx-bubble{right:16px;bottom:16px}.nx-theme-classic .nx-panel{right:0!important;left:0!important;bottom:0!important;top:auto!important;width:100%!important;height:85vh!important;border-radius:16px 16px 0 0;max-width:100%;resize:none!important}.nx-theme-classic .nx-resize-handle{display:none!important}}",
  ].join("");
  document.head.appendChild(style);

  var root = document.createElement("div");
  root.className = "nx-root nx-theme-modern";
  document.body.appendChild(root);

  bubble = document.createElement("button");
  bubble.className = "nx-bubble";
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.textContent = getLauncherIcon();
  root.appendChild(bubble);

  function applyThemeShell() {
    var theme = getTheme();
    root.className = "nx-root nx-theme-" + theme;
    if (theme === "modern") {
      loadModernWidth();
      root.style.setProperty("--nx-panel-width", modernWidth + "px");
    } else {
      restoreHostSplit();
    }
    bubble.style.background = getPrimary();
    bubble.textContent = getLauncherIcon();
  }

  function headerStyle(primary) {
    return getTheme() === "classic"
      ? ' style="background:' + primary + '"'
      : "";
  }

  function buildPanel() {
    var primary = getPrimary();
    var title =
      (config &&
        config.widget_config &&
        config.widget_config.header_title) ||
      "Customer Support";
    var placeholder =
      (config &&
        config.widget_config &&
        config.widget_config.placeholder_text) ||
      "Type a message\u2026";
    var online = state.online;

    panel = document.createElement("div");
    panel.className = "nx-panel";
    panel.style.display = "none";
    if (getTheme() === "modern") {
      panel.style.setProperty("--nx-panel-width", modernWidth + "px");
    }

    panel.innerHTML =
      '<div id="nx-header" class="nx-header"' +
      headerStyle(primary) +
      ">" +
      '<div class="nx-header-left">' +
      '<span class="nx-header-title">' +
      esc(title) +
      "</span>" +
      '<span class="nx-header-sub">' +
      '<span class="nx-online-dot" style="background:' +
      (online ? "#22c55e" : "#9ca3af") +
      '"></span>' +
      (online ? "Online" : "Offline") +
      "  \u00b7  Chat #" +
      getTicketNo() +
      "</span>" +
      "</div>" +
      '<div class="nx-header-actions">' +
      '<button id="nx-my-tickets-btn" class="nx-header-btn" title="My Tickets" type="button">\u2637</button>' +
      '<button id="nx-close-btn" class="nx-header-btn" title="Close" type="button">\u00d7</button>' +
      "</div>" +
      "</div>" +
      '<div id="nx-tags-area" class="nx-tags" style="display:none"></div>' +
      '<div id="nx-msgs" class="nx-msgs"></div>' +
      '<div id="nx-human-state" class="nx-human-state" role="status" aria-live="polite"></div>' +
      '<div id="nx-input-area" class="nx-input-area">' +
      '<div class="nx-input-row">' +
      '<div class="nx-plus-wrap">' +
      '<button id="nx-plus-btn" class="nx-plus-btn" title="More" type="button">+</button>' +
      "</div>" +
      '<button id="nx-emoji-btn" class="nx-emoji-btn" title="Emoji" type="button">\u263a</button>' +
      '<textarea id="nx-input" placeholder="' +
      esc(placeholder) +
      '" rows="1"></textarea>' +
      '<button id="nx-send" class="nx-send" style="background:' +
      primary +
      '" type="button">Send</button>' +
      "</div>" +
      "</div>" +
      '<div class="nx-footer">Powered by NexusAI</div>';

    root.appendChild(panel);

    msgsEl = panel.querySelector("#nx-msgs");
    inputEl = panel.querySelector("#nx-input");
    sendBtn = panel.querySelector("#nx-send");
    tagsEl = panel.querySelector("#nx-tags-area");

    panel.querySelector("#nx-close-btn").addEventListener("click", closePanel);
    panel
      .querySelector("#nx-my-tickets-btn")
      .addEventListener("click", showMyTickets);
    sendBtn.addEventListener("click", handleSend);

    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    inputEl.addEventListener("input", function () {
      inputEl.style.height = getTheme() === "modern" ? "44px" : "36px";
      inputEl.style.height =
        Math.min(inputEl.scrollHeight, getTheme() === "modern" ? 140 : 120) +
        "px";
    });

    panel.querySelector("#nx-plus-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      togglePlusMenu();
    });

    panel.querySelector("#nx-emoji-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      toggleEmojiPanel();
    });

    document.addEventListener("click", function () {
      closePlusMenu();
      closeEmojiPanel();
    });

    if (getTheme() === "modern") {
      initModernResize();
    } else {
      initClassicDrag();
      initClassicResize();
    }

    showSuggestedQuestions();
  }

  function initModernResize() {
    if (!panel || modernDividerEl) return;
    modernDividerEl = document.createElement("div");
    modernDividerEl.className = "nx-modern-divider";
    modernDividerEl.setAttribute("role", "separator");
    modernDividerEl.setAttribute("aria-orientation", "vertical");
    modernDividerEl.title = "Drag to resize assistant";
    panel.appendChild(modernDividerEl);

    var dragging = false;

    function move(e) {
      if (!dragging || isMobile()) return;
      var width = clampModernWidth(window.innerWidth - e.clientX);
      saveModernWidth(width);
      panel.style.setProperty("--nx-panel-width", modernWidth + "px");
      root.style.setProperty("--nx-panel-width", modernWidth + "px");
      applyHostSplit(true);
      e.preventDefault();
    }

    function up() {
      if (!dragging) return;
      dragging = false;
      modernDividerEl.classList.remove("dragging");
      document.body.style.userSelect = "";
    }

    modernDividerEl.addEventListener("mousedown", function (e) {
      if (isMobile()) return;
      dragging = true;
      modernDividerEl.classList.add("dragging");
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  function initClassicDrag() {
    var header = panel && panel.querySelector("#nx-header");
    if (!header) return;
    var dragging = false;
    var offsetX = 0;
    var offsetY = 0;

    header.addEventListener("mousedown", function (e) {
      if (isMobile()) return;
      if (e.target.closest("button") || e.target.closest(".nx-header-actions"))
        return;
      dragging = true;
      var rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      header.classList.add("dragging");
      e.preventDefault();
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var rect = panel.getBoundingClientRect();
      var left = Math.max(
        0,
        Math.min(e.clientX - offsetX, window.innerWidth - rect.width),
      );
      var top = Math.max(
        0,
        Math.min(e.clientY - offsetY, window.innerHeight - rect.height),
      );
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    });

    document.addEventListener("mouseup", function () {
      dragging = false;
      header.classList.remove("dragging");
    });
  }

  function initClassicResize() {
    if (!panel) return;
    var handle = document.createElement("div");
    handle.className = "nx-resize-handle";
    handle.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 20 20" style="opacity:.55"><circle cx="5" cy="15" r="1.5" fill="rgba(0,0,0,.45)"/><circle cx="10" cy="15" r="1.5" fill="rgba(0,0,0,.45)"/><circle cx="15" cy="15" r="1.5" fill="rgba(0,0,0,.45)"/><circle cx="10" cy="10" r="1.5" fill="rgba(0,0,0,.45)"/><circle cx="15" cy="10" r="1.5" fill="rgba(0,0,0,.45)"/><circle cx="15" cy="5" r="1.5" fill="rgba(0,0,0,.45)"/></svg>';
    panel.appendChild(handle);

    var resizing = false;
    var startX = 0;
    var startY = 0;
    var startW = 0;
    var startH = 0;
    var startRight = 0;

    handle.addEventListener("mousedown", function (e) {
      if (isMobile()) return;
      resizing = true;
      var rect = panel.getBoundingClientRect();
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = rect.left + "px";
      panel.style.top = rect.top + "px";
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      startRight = rect.right;
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener("mousemove", function (e) {
      if (!resizing) return;
      var newWidth = Math.max(
        300,
        Math.min(startW + (startX - e.clientX), 800),
      );
      var newHeight = Math.max(
        400,
        Math.min(startH + (e.clientY - startY), window.innerHeight * 0.9),
      );
      panel.style.width = newWidth + "px";
      panel.style.height = newHeight + "px";
      panel.style.left = Math.max(0, startRight - newWidth) + "px";
    });

    document.addEventListener("mouseup", function () {
      resizing = false;
    });
  }

  function togglePlusMenu() {
    if (plusMenuEl) {
      closePlusMenu();
      return;
    }
    closeEmojiPanel();
    var inputArea = panel.querySelector("#nx-input-area");
    plusMenuEl = document.createElement("div");
    plusMenuEl.className = "nx-plus-menu";

    var item = document.createElement("div");
    item.id = "nx-menu-human";
    item.className =
      "nx-plus-item" + (state.handoffRequested ? " disabled" : "");
    item.innerHTML = "<span>\ud83d\udc64</span> Request Human Support";
    plusMenuEl.appendChild(item);

    inputArea.querySelector(".nx-plus-wrap").appendChild(plusMenuEl);

    if (!state.handoffRequested) {
      item.addEventListener("click", function (e) {
        e.stopPropagation();
        closePlusMenu();
        handleHumanSupport();
      });
    }
  }

  function closePlusMenu() {
    if (plusMenuEl && plusMenuEl.parentNode) {
      plusMenuEl.parentNode.removeChild(plusMenuEl);
    }
    plusMenuEl = null;
  }

  var EMOJIS = [
    "\ud83d\ude0a",
    "\ud83d\ude02",
    "\ud83d\ude4f",
    "\ud83d\udc4d",
    "\u2764\ufe0f",
    "\ud83c\udf89",
    "\ud83d\ude05",
    "\ud83d\ude2d",
    "\ud83d\udd25",
    "\u2705",
    "\ud83d\udc4b",
    "\ud83d\ude0d",
    "\ud83e\udd14",
    "\ud83d\ude22",
    "\ud83d\ude0e",
    "\ud83d\ude4c",
    "\ud83d\udcaa",
    "\ud83d\ude01",
    "\ud83e\udd70",
    "\ud83e\udd29",
    "\ud83d\ude34",
    "\ud83d\ude21",
    "\ud83d\udc40",
    "\ud83d\udcaf",
  ];

  function toggleEmojiPanel() {
    if (emojiPanelEl) {
      closeEmojiPanel();
      return;
    }
    closePlusMenu();
    emojiPanelEl = document.createElement("div");
    emojiPanelEl.className = "nx-emoji-panel";
    EMOJIS.forEach(function (emoji) {
      var btn = document.createElement("button");
      btn.className = "nx-emoji-item";
      btn.type = "button";
      btn.textContent = emoji;
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        insertEmoji(emoji);
      });
      emojiPanelEl.appendChild(btn);
    });
    panel.querySelector("#nx-input-area").appendChild(emojiPanelEl);
  }

  function closeEmojiPanel() {
    if (emojiPanelEl && emojiPanelEl.parentNode) {
      emojiPanelEl.parentNode.removeChild(emojiPanelEl);
    }
    emojiPanelEl = null;
  }

  function insertEmoji(emoji) {
    if (!inputEl) return;
    var start = inputEl.selectionStart || inputEl.value.length;
    var end = inputEl.selectionEnd || inputEl.value.length;
    inputEl.value =
      inputEl.value.substring(0, start) +
      emoji +
      inputEl.value.substring(end);
    inputEl.selectionStart = inputEl.selectionEnd = start + emoji.length;
    inputEl.focus();
  }

  function handleHumanSupport() {
    if (
      !state.sessionToken ||
      !state.conversationId ||
      state.handoffRequested
    )
      return;

    api("/receive-widget-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: state.conversationId,
        session_token: state.sessionToken,
        content: "I\u2019d like to speak with a human agent.",
      }),
    })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.success) {
          appendMessageObj({
            id: "system-handoff-error-" + Date.now(),
            role: "system",
            content:
              "Human support request could not be sent. Please try again.",
            created_at: new Date().toISOString(),
          });
          return;
        }
        pollStep = 0;
        if (pollActive) executePoll();
        else startPolling();
      })
      .catch(function () {
        appendMessageObj({
          id: "system-handoff-error-" + Date.now(),
          role: "system",
          content:
            "Human support request could not be sent. Please try again.",
          created_at: new Date().toISOString(),
        });
      });
  }

  function showSuggestedQuestions() {
    if (!tagsEl || state.firstMessageSent) return;
    var questions = getSuggested();
    if (!questions.length) return;
    tagsEl.innerHTML = "";
    questions.forEach(function (question) {
      var btn = document.createElement("button");
      btn.className = "nx-tag";
      btn.type = "button";
      btn.textContent = question;
      btn.addEventListener("click", function () {
        if (inputEl) inputEl.value = question;
        hideTags();
        handleSend();
      });
      tagsEl.appendChild(btn);
    });
    tagsEl.style.display = "flex";
  }

  function hideTags() {
    if (tagsEl) tagsEl.style.display = "none";
    state.firstMessageSent = true;
  }

  function showMyTickets() {
    if (!panel) return;
    var primary = getPrimary();
    var page = document.createElement("div");
    page.className = "nx-tickets-page";

    var header = document.createElement("div");
    header.className = "nx-tickets-header";
    if (getTheme() === "classic") header.style.background = primary;

    var back = document.createElement("button");
    back.className = "nx-tickets-back";
    back.type = "button";
    back.textContent = "\u2190";
    var label = document.createElement("span");
    label.textContent = "My Tickets";
    header.appendChild(back);
    header.appendChild(label);

    var list = document.createElement("div");
    list.className = "nx-tickets-list";
    var tickets = getTickets();

    if (!tickets.length) {
      var empty = document.createElement("div");
      empty.className = "nx-tickets-empty";
      empty.innerHTML =
        '<div style="font-size:32px;margin-bottom:8px">\ud83d\udccb</div><div>No previous tickets</div>';
      list.appendChild(empty);
    } else {
      tickets.forEach(function (ticket) {
        var item = document.createElement("div");
        item.className = "nx-ticket-item";
        var labelText =
          ticket.status === "resolved"
            ? "Resolved"
            : ticket.status === "human_needed"
              ? "Waiting"
              : "Open";

        item.innerHTML =
          '<div class="nx-ticket-row">' +
          '<span class="nx-ticket-no">Chat #' +
          esc(ticket.ticket_no) +
          "</span>" +
          '<span class="nx-ticket-status ' +
          esc(ticket.status) +
          '">' +
          esc(labelText) +
          "</span></div>" +
          '<div class="nx-ticket-preview">' +
          esc(ticket.last_message || "(no messages yet)") +
          "</div>" +
          '<div class="nx-ticket-time">' +
          esc(new Date(ticket.updated_at).toLocaleDateString()) +
          "</div>";

        item.addEventListener("click", function () {
          page.remove();
          tryRestoreSession({
            convId: ticket.conversation_id,
            token: ticket.session_token,
          });
        });
        list.appendChild(item);
      });
    }

    var newChat = document.createElement("button");
    newChat.className = "nx-tickets-new";
    newChat.type = "button";
    newChat.style.background = primary;
    newChat.textContent = "+ Start New Conversation";

    page.appendChild(header);
    page.appendChild(list);
    page.appendChild(newChat);
    panel.appendChild(page);

    back.addEventListener("click", function () {
      page.remove();
    });
    newChat.addEventListener("click", function () {
      page.remove();
      resetAndFresh();
    });
  }

  function isLocalId(id) {
    var value = String(id || "");
    return (
      value.indexOf("system-") === 0 ||
      value.indexOf("err-") === 0 ||
      value === "welcome"
    );
  }

  function renderMsg(message) {
    if (message.is_recalled) {
      var recalled = document.createElement("div");
      recalled.className = "nx-recalled";
      recalled.textContent = "[\u8a0a\u606f\u5df2\u64a4\u56de]";
      return recalled;
    }

    var el = document.createElement("div");
    el.className = "nx-msg " + (message.role || "assistant");
    if (message.role === "visitor") el.style.background = getPrimary();
    el.textContent = message.content;

    if (
      (message.role === "assistant" || message.role === "ai") &&
      message.metadata &&
      Array.isArray(message.metadata.citations) &&
      message.metadata.citations.length > 0
    ) {
      var citeWrap = document.createElement("div");
      citeWrap.className = "nx-citations";
      var citeTitle = document.createElement("div");
      citeTitle.className = "nx-citations-title";
      citeTitle.textContent = "Sources / \u8cc7\u6599\u4f86\u6e90";
      citeWrap.appendChild(citeTitle);
      var shown = 0;

      for (
        var i = 0;
        i < message.metadata.citations.length && shown < 3;
        i++
      ) {
        var cite = message.metadata.citations[i];
        if (!cite || typeof cite.label !== "string" || !cite.label.trim())
          continue;
        var item = document.createElement("div");
        item.className = "nx-cite-item";
        if (cite.source_type && typeof cite.source_type === "string") {
          var badge = document.createElement("span");
          badge.className = "nx-cite-badge";
          badge.textContent = cite.source_type;
          item.appendChild(badge);
        }
        var labelSpan = document.createElement("span");
        labelSpan.textContent = cite.label.slice(0, 120);
        item.appendChild(labelSpan);
        citeWrap.appendChild(item);
        shown++;
      }

      if (shown > 0) el.appendChild(citeWrap);
    }

    if (
      message.role === "system" &&
      message.metadata &&
      message.metadata.feedback_request === true &&
      typeof message.metadata.feedback_link === "string"
    ) {
      try {
        var feedbackUrl = new URL(message.metadata.feedback_link);
        if (feedbackUrl.protocol === "https:") {
          var cta = document.createElement("a");
          cta.className = "nx-feedback-cta";
          cta.href = feedbackUrl.toString();
          cta.target = "_blank";
          cta.rel = "noopener noreferrer";
          cta.style.background = getPrimary();
          cta.textContent = "Rate your experience";
          el.appendChild(cta);
        }
      } catch (e) {}
    }

    return el;
  }

  function appendMessageObj(message) {
    if (
      !msgsEl ||
      message.content === "__THINKING__" ||
      seenIds[message.id]
    )
      return;

    seenIds[message.id] = true;
    var idx = state.messages.findIndex(function (x) {
      return x.id === message.id;
    });
    if (idx >= 0) state.messages[idx] = message;
    else state.messages.push(message);

    var el = renderMsg(message);
    if (typingEl && typingEl.parentNode === msgsEl) {
      msgsEl.insertBefore(el, typingEl);
    } else {
      msgsEl.appendChild(el);
    }

    if (!isLocalId(message.id)) {
      lastMessageId = message.id;
      if (message.role !== "system") {
        updateTicket(
          state.conversationId,
          null,
          String(message.content || "").substring(0, 80),
        );
      }
    }

    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function appendWelcome() {
    var welcome =
      config &&
      config.widget_config &&
      config.widget_config.welcome_message;
    if (!welcome && !state.online) {
      welcome =
        (config &&
          config.widget_config &&
          config.widget_config.offline_message) ||
        "Our team is currently offline. Please leave a message.";
    }
    if (welcome) {
      appendMessageObj({
        id: "welcome",
        role: "assistant",
        content: welcome,
      });
    }
  }

  function updateHeader() {
    if (!panel) return;
    var sub = panel.querySelector(".nx-header-sub");
    if (!sub) return;
    sub.innerHTML =
      '<span class="nx-online-dot" style="background:' +
      (state.online ? "#22c55e" : "#9ca3af") +
      '"></span>' +
      (state.online ? "Online" : "Offline") +
      "  \u00b7  Chat #" +
      esc(getTicketNo());
  }

  function showTyping() {
    if (!typingEl) {
      typingEl = document.createElement("div");
      typingEl.className = "nx-typing";
      typingEl.id = "nexus-typing-indicator";
      typingEl.innerHTML = "<span></span><span></span><span></span>";
    }
    if (msgsEl && typingEl.parentNode !== msgsEl) {
      msgsEl.appendChild(typingEl);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  }

  function hideTyping() {
    if (typingEl && typingEl.parentNode) {
      typingEl.parentNode.removeChild(typingEl);
    }
  }

  function applyHumanSupportState(humanSupport) {
    if (!panel) return;
    var el = panel.querySelector("#nx-human-state");
    if (!el) return;

    var value =
      humanSupport && typeof humanSupport.state === "string"
        ? humanSupport.state
        : "none";

    el.className = "nx-human-state";
    el.textContent = "";

    if (value === "waiting") {
      state.handoffRequested = true;
      hideTyping();
      state.thinkingStartTime = null;
      state.fallbackShownForConversation = true;
      el.classList.add("waiting");
      el.textContent =
        "Human support requested. You are waiting for a team member. You can continue sending messages here.";
      updateTicket(state.conversationId, "human_needed", null);
      return;
    }

    if (value === "assigned") {
      state.handoffRequested = true;
      hideTyping();
      state.thinkingStartTime = null;
      state.fallbackShownForConversation = true;
      el.classList.add("assigned");
      el.textContent =
        "A human support agent is connected. AI replies are paused while the agent handles this conversation.";
      updateTicket(state.conversationId, "human_needed", null);
      return;
    }

    state.handoffRequested = false;
  }

  function showResolvedBanner(messages) {
    if (!msgsEl) return;
    msgsEl.innerHTML = "";
    seenIds = {};
    state.messages = [];
    lastMessageId = null;
    state.firstMessageSent = true;
    hideTags();

    (messages || []).forEach(function (message) {
      appendMessageObj(message);
    });

    var banner = document.createElement("div");
    banner.className = "nx-resolved";
    banner.innerHTML =
      '\u2705 This conversation has been resolved.<br><button class="nx-new-chat">Start new conversation</button>';
    msgsEl.appendChild(banner);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    if (inputEl) {
      inputEl.disabled = true;
      inputEl.placeholder = "Conversation resolved.";
    }
    if (sendBtn) sendBtn.disabled = true;

    updateTicket(state.conversationId, "resolved", null);

    banner
      .querySelector(".nx-new-chat")
      .addEventListener("click", resetAndFresh);
  }

  function resetAndFresh() {
    invalidatePollingContext();
    clearSession();
    state.sessionToken = null;
    state.conversationId = null;
    state.messages = [];
    state.handoffRequested = false;
    state.firstMessageSent = false;
    state.fallbackShownForConversation = false;
    state.thinkingStartTime = null;
    seenIds = {};
    lastMessageId = null;

    if (panel) {
      var humanState = panel.querySelector("#nx-human-state");
      if (humanState) {
        humanState.className = "nx-human-state";
        humanState.textContent = "";
      }
    }

    if (inputEl) {
      inputEl.disabled = false;
      inputEl.placeholder =
        (config &&
          config.widget_config &&
          config.widget_config.placeholder_text) ||
        "Type a message\u2026";
    }
    if (sendBtn) sendBtn.disabled = false;

    startFreshSession();
  }

  function api(path, opts) {
    return fetch(apiBase + path, opts).then(function (response) {
      return response.json().then(function (body) {
        return {
          ok: response.ok,
          status: response.status,
          body: body,
        };
      });
    });
  }

  function startPolling() {
    if (pollActive) return;
    pollActive = true;
    pollStep = 0;
    catchUpPending = false;
    schedulePoll();
  }

  function stopPolling() {
    pollActive = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    state.pollInterval = null;
  }

  function invalidatePollingContext() {
    stopPolling();
    pollGeneration++;
    catchUpPending = false;
    pollStep = 0;
  }

  function schedulePoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (!pollActive || document.hidden) return;
    var ms = POLL_STEPS[Math.min(pollStep, POLL_STEPS.length - 1)];
    pollTimer = setTimeout(executePoll, ms);
    state.pollInterval = pollTimer;
  }

  function executePoll() {
    pollTimer = null;
    state.pollInterval = null;
    if (!pollActive || document.hidden) return;

    if (activePollRequest) {
      catchUpPending = true;
      return;
    }

    if (!state.conversationId || !state.sessionToken) {
      stopPolling();
      return;
    }

    var request = {
      id: ++pollRequestSeq,
      generation: pollGeneration,
    };
    activePollRequest = request;

    api("/widget-poll-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: state.conversationId,
        session_token: state.sessionToken,
        after_message_id: lastMessageId || null,
      }),
    })
      .then(function (res) {
        if (request.generation !== pollGeneration) return;

        if (!res.ok || !res.body || !res.body.success) {
          if (pollStep < POLL_STEPS.length - 1) pollStep++;
          return;
        }

        var data = res.body.data;

        if (data.conversation_status === "resolved") {
          hideTyping();
          stopPolling();
          var newMessages = data.messages || [];
          newMessages.forEach(function (message) {
            if (
              !state.messages.some(function (x) {
                return x.id === message.id;
              })
            ) {
              state.messages.push(message);
            }
          });

          var merged = state.messages
            .filter(function (message) {
              return message.content !== "__THINKING__";
            })
            .filter(function (message, index, all) {
              return (
                all.findIndex(function (x) {
                  return x.id === message.id;
                }) === index
              );
            })
            .sort(function (a, b) {
              return new Date(a.created_at) - new Date(b.created_at);
            });

          showResolvedBanner(merged);
          return;
        }

        var incoming = data.messages || [];
        var hadNew = false;

        incoming.forEach(function (message) {
          if (!seenIds[message.id]) hadNew = true;
          appendMessageObj(message);
          if (message.role === "visitor") hideTags();
        });

        if (hadNew) pollStep = 0;
        else if (pollStep < POLL_STEPS.length - 1) pollStep++;

        applyHumanSupportState(data.human_support);

        var aiGenerating = data.ai_generating;

        if (aiGenerating && state.handoffRequested) {
          hideTyping();
          state.thinkingStartTime = null;
          state.fallbackShownForConversation = true;
          return;
        }

        if (aiGenerating) {
          if (!state.thinkingStartTime) {
            state.thinkingStartTime = Date.now();
          }
          state.fallbackShownForConversation = false;
          if (!document.getElementById("nexus-typing-indicator")) {
            showTyping();
          }
        } else {
          state.thinkingStartTime = null;
          state.fallbackShownForConversation = false;
          hideTyping();
        }
      })
      .catch(function () {
        if (request.generation !== pollGeneration) return;
        if (pollStep < POLL_STEPS.length - 1) pollStep++;
      })
      .then(function () {
        var ownsActive = activePollRequest === request;
        if (ownsActive) activePollRequest = null;

        if (request.generation !== pollGeneration) {
          if (
            ownsActive &&
            pollActive &&
            !document.hidden &&
            state.conversationId &&
            state.sessionToken
          ) {
            catchUpPending = false;
            pollStep = 0;
            executePoll();
          }
          return;
        }

        if (catchUpPending && pollActive && !document.hidden) {
          catchUpPending = false;
          pollStep = 0;
          executePoll();
        } else if (pollActive) {
          schedulePoll();
        }
      });
  }

  function startFreshSession() {
    if (msgsEl) {
      msgsEl.innerHTML =
        '<div style="text-align:center;padding:40px 20px;color:#9ca3af"><div style="font-size:32px;margin-bottom:8px">\u231b</div><div>Connecting\u2026</div></div>';
    }

    state.messages = [];
    seenIds = {};
    lastMessageId = null;

    api("/create-visitor-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId }),
    })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.success) {
          if (msgsEl) {
            msgsEl.innerHTML =
              '<div style="text-align:center;padding:40px 20px;color:#9ca3af"><div style="font-size:32px;margin-bottom:8px">\u26a0</div><div>Unable to start session.</div></div>';
          }
          return;
        }

        state.sessionToken = res.body.data.session_token;
        state.conversationId = res.body.data.conversation_id;
        saveSession();
        saveTicket(state.conversationId, state.sessionToken);
        updateHeader();

        if (msgsEl) msgsEl.innerHTML = "";

        state.online = isOnline();
        appendWelcome();
        showSuggestedQuestions();
        startPolling();
      })
      .catch(function () {
        if (msgsEl) {
          msgsEl.innerHTML =
            '<div style="text-align:center;padding:40px 20px;color:#9ca3af"><div style="font-size:32px;margin-bottom:8px">\u26a0</div><div>Connection failed.</div></div>';
        }
      });
  }

  function tryRestoreSession(stored) {
    invalidatePollingContext();

    if (msgsEl) {
      msgsEl.innerHTML =
        '<div style="text-align:center;padding:40px 20px;color:#9ca3af"><div style="font-size:32px;margin-bottom:8px">\u231b</div><div>Resuming\u2026</div></div>';
    }
    hideTags();

    api("/widget-poll-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: stored.convId,
        session_token: stored.token,
        after_message_id: null,
      }),
    })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.success) {
          throw new Error("restore_failed");
        }

        var data = res.body.data;
        state.sessionToken = stored.token;
        state.conversationId = stored.convId;
        saveSession();
        saveTicket(state.conversationId, state.sessionToken);
        state.messages = [];
        seenIds = {};
        lastMessageId = null;

        if (msgsEl) msgsEl.innerHTML = "";
        updateHeader();

        if (data.conversation_status === "resolved") {
          showResolvedBanner(data.messages || []);
          return;
        }

        applyHumanSupportState(data.human_support);
        var messages = data.messages || [];

        if (messages.length === 0) {
          appendWelcome();
          showSuggestedQuestions();
        } else {
          messages.forEach(function (message) {
            appendMessageObj(message);
          });
          state.firstMessageSent = true;
        }

        startPolling();
      })
      .catch(function () {
        clearSession();
        state.sessionToken = null;
        state.conversationId = null;
        startFreshSession();
      });
  }

  function setPanelVisible(open) {
    if (!panel) return;
    if (getTheme() === "modern") {
      panel.style.display = "flex";
      if (open) {
        panel.style.setProperty("--nx-panel-width", modernWidth + "px");
        root.style.setProperty("--nx-panel-width", modernWidth + "px");
        requestAnimationFrame(function () {
          panel.classList.add("nx-open");
        });
      } else {
        panel.classList.remove("nx-open");
      }
      bubble.style.opacity = open ? "0" : "1";
      bubble.style.pointerEvents = open ? "none" : "auto";
      applyHostSplit(open);
      return;
    }

    panel.style.display = open ? "flex" : "none";
    restoreHostSplit();
    bubble.style.opacity = "1";
    bubble.style.pointerEvents = "auto";
  }

  function openPanel() {
    if (panel && (getTheme() === "modern" ? panel.classList.contains("nx-open") : panel.style.display !== "none")) return;

    var configPromise = config
      ? Promise.resolve()
      : api(
          "/get-public-widget-config?channel_id=" +
            encodeURIComponent(channelId),
          { method: "GET" },
        ).then(function (res) {
          if (!res.ok || !res.body || !res.body.success) {
            throw new Error("config_failed");
          }
          config = res.body.data;
          state.online = isOnline();
          applyThemeShell();
        });

    configPromise
      .then(function () {
        applyThemeShell();
        if (!panel) buildPanel();
        setPanelVisible(true);

        if (state.sessionToken && state.conversationId) {
          startPolling();
          return;
        }

        var stored = loadSession();
        if (
          stored.token &&
          stored.convId &&
          stored.channel === channelId
        ) {
          tryRestoreSession(stored);
        } else {
          startFreshSession();
        }
      })
      .catch(function () {
        if (msgsEl) {
          msgsEl.innerHTML =
            '<div style="text-align:center;padding:40px 20px;color:#9ca3af"><div style="font-size:32px;margin-bottom:8px">\u26a0</div><div>Chat unavailable.</div></div>';
        }
      });
  }

  function closePanel() {
    if (panel) setPanelVisible(false);
    stopPolling();
    closePlusMenu();
    closeEmojiPanel();
  }

  function handleSend() {
    if (!inputEl) return;
    var text = inputEl.value.trim();

    if (!text || !state.conversationId || !state.sessionToken) return;

    if (text.length > 2000) {
      alert("Message too long (max 2000).");
      return;
    }

    hideTags();
    sendBtn.disabled = true;
    sendBtn.textContent = "\u2026";
    inputEl.value = "";
    inputEl.style.height = getTheme() === "modern" ? "44px" : "36px";

    api("/receive-widget-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: state.conversationId,
        session_token: state.sessionToken,
        content: text,
      }),
    })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.success) {
          appendMessageObj({
            id: "err-" + Date.now(),
            role: "system",
            content:
              (res.body && res.body.error) || "Failed to send.",
            created_at: new Date().toISOString(),
          });
        }
      })
      .catch(function () {
        appendMessageObj({
          id: "err-" + Date.now(),
          role: "system",
          content: "Network error.",
          created_at: new Date().toISOString(),
        });
      })
      .then(function () {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
        state.fallbackShownForConversation = false;
        state.thinkingStartTime = null;
        pollStep = 0;
        if (!pollActive && state.conversationId) {
          startPolling();
        } else if (pollActive) {
          schedulePoll();
        }
      });
  }

  bubble.addEventListener("click", function () {
    if (panel && (getTheme() === "modern" ? panel.classList.contains("nx-open") : panel.style.display !== "none")) closePanel();
    else openPanel();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
        state.pollInterval = null;
      }
    } else if (
      pollActive &&
      state.sessionToken &&
      state.conversationId
    ) {
      pollStep = 0;
      if (activePollRequest) {
        catchUpPending = true;
      } else {
        executePoll();
      }
    }
  });

  window.addEventListener("resize", function () {
    if (getTheme() !== "modern" || !panel) return;
    if (isMobile()) {
      restoreHostSplit();
      return;
    }
    modernWidth = clampModernWidth(modernWidth);
    panel.style.setProperty("--nx-panel-width", modernWidth + "px");
    root.style.setProperty("--nx-panel-width", modernWidth + "px");
    if (panel.classList.contains("nx-open")) applyHostSplit(true);
  });

  api(
    "/get-public-widget-config?channel_id=" +
      encodeURIComponent(channelId),
    { method: "GET" },
  )
    .then(function (res) {
      if (
        res.ok &&
        res.body &&
        res.body.success &&
        res.body.data &&
        res.body.data.widget_config
      ) {
        config = res.body.data;
        state.online = isOnline();
        applyThemeShell();
      }
    })
    .catch(function () {});

  console.log(
    "[NexusAI widget] Shared runtime v1.4.0 loaded; modern assistant panel + classic popup; channel:",
    channelId,
  );
  console.log(
    "[NexusAI widget] File upload hidden until real backend support is available.",
  );
})();