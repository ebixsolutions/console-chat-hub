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
    document.documentElement.style.setProperty("--nexus-assistant-width", modernWidth + "px");
    document.body.style.marginRight = "calc(" + base + " + " + modernWidth + "px)";
    document.body.style.transition = "margin-right 160ms ease";
    document.documentElement.classList.add("nexus-assistant-open");
    try { window.dispatchEvent(new Event("resize")); } catch (e) {}
  }

  function restoreHostSplit() {
    document.documentElement.classList.remove("nexus-assistant-open");
    document.documentElement.style.removeProperty("--nexus-assistant-width");
    if (hostLayoutCaptured) {
      document.body.style.marginRight = hostOriginalMarginRight;
      document.body.style.transition = hostOriginalTransition;
    } else if (document.body.dataset.nexusAssistantAdjusted === "true") {
      document.body.style.marginRight = document.body.dataset.nexusAssistantBaseMargin || "";
    }
    delete document.body.dataset.nexusAssistantAdjusted;
    delete document.body.dataset.nexusAssistantBaseMargin;
    try { window.dispatchEvent(new Event("resize")); } catch (e) {}
  }

  /* NOTE: unchanged widget rendering / transport code omitted here would be unsafe to replace.
     This file replacement is intentionally not applied because complete source is required. */
})();
