/* NexusAI Customer Support Widget — Widget MVP v1.1
   Features: Session Persistence + Ticket No + Suggested Questions
             + Online/Offline + Human Support + My Tickets + Upload placeholder */
(function () {
  if (window.__nexusChatLoaded) return;
  window.__nexusChatLoaded = true;

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName("script");
    return s[s.length - 1];
  })();
  var channelId = script.getAttribute("data-channel-id");
  var apiBase = (script.getAttribute("data-api-base") || "").replace(/\/$/, "");
  if (!channelId || !apiBase) {
    console.error("[NexusAI] data-channel-id and data-api-base are required");
    return;
  }

  // ---------- L2.1 localStorage (channel-scoped) ----------
  var STORAGE_PREFIX    = "nexus_widget_" + channelId;
  var SK_TOKEN          = STORAGE_PREFIX + "_session_token";
  var SK_CONV           = STORAGE_PREFIX + "_conversation_id";
  var SK_CHANNEL        = STORAGE_PREFIX + "_channel_id";
  var SK_TICKETS        = STORAGE_PREFIX + "_tickets";

  function saveSession() {
    try {
      localStorage.setItem(SK_TOKEN,   state.sessionToken);
      localStorage.setItem(SK_CONV,    state.conversationId);
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
        token:   localStorage.getItem(SK_TOKEN),
        convId:  localStorage.getItem(SK_CONV),
        channel: localStorage.getItem(SK_CHANNEL)
      };
    } catch (e) { return {}; }
  }

  // ---------- Ticket History (My Tickets) ----------
  function saveTicketToHistory(conversationId, sessionToken) {
    try {
      var tickets = JSON.parse(localStorage.getItem(SK_TICKETS) || "[]");
      var exists = tickets.some(function(t){ return t.conversation_id === conversationId; });
      if (!exists) {
        tickets.unshift({
          ticket_no: conversationId.substring(0, 7),
          conversation_id: conversationId,
          session_token: sessionToken,
          status: "open",
          last_message: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
        localStorage.setItem(SK_TICKETS, JSON.stringify(tickets.slice(0, 20)));
      }
    } catch (e) {}
  }
  function updateTicketInHistory(conversationId, status, lastMessage) {
    try {
      var tickets = JSON.parse(localStorage.getItem(SK_TICKETS) || "[]");
      var idx = tickets.findIndex(function(t){ return t.conversation_id === conversationId; });
      if (idx >= 0) {
        tickets[idx].status = status || tickets[idx].status;
        if (lastMessage) tickets[idx].last_message = lastMessage;
        tickets[idx].updated_at = new Date().toISOString();
        localStorage.setItem(SK_TICKETS, JSON.stringify(tickets));
      }
    } catch (e) {}
  }
  function getTicketHistory() {
    try { return JSON.parse(localStorage.getItem(SK_TICKETS) || "[]"); }
    catch (e) { return []; }
  }

  // ---------- Online/Offline ----------
  function isOnline() {
    var cfg = config && config.widget_config;
    if (!cfg || !cfg.business_hours || !cfg.business_hours.schedule) return true;
    var tz = cfg.business_hours.timezone || "UTC";
    var schedule = cfg.business_hours.schedule;
    try {
      var now = new Date();
      var localStr = now.toLocaleString("en-US", { timeZone: tz, hour12: false,
        weekday: "short", hour: "2-digit", minute: "2-digit" });
      var parts = localStr.split(", ");
      var dayMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
      var todayNum = dayMap[parts[0]] !== undefined ? dayMap[parts[0]] : now.getDay();
      var timeParts = parts[1].split(":");
      var currentMins = parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]);
      for (var i = 0; i < schedule.length; i++) {
        var s = schedule[i];
        if (s.days && s.days.indexOf(todayNum) !== -1) {
          var open  = s.open.split(":").reduce(function(h,m){ return parseInt(h)*60+parseInt(m); });
          var close = s.close.split(":").reduce(function(h,m){ return parseInt(h)*60+parseInt(m); });
          if (currentMins >= open && currentMins < close) return true;
        }
      }
      return false;
    } catch (e) { return true; }
  }

  // ---------- State ----------
  var config = null;
  var lastMessageId = null;
  var seenIds = {};
  var state = {
    sessionToken: null,
    conversationId: null,
    pollInterval: null,
    thinkingStartTime: null,
    fallbackShownForConversation: false,
    handoffRequested: false,
    firstMessageSent: false,
    messages: [],
    online: true
  };

  // ---------- Styles ----------
  var style = document.createElement("style");
  style.textContent = [
    ".nx-root *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".nx-bubble{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:9999px;border:none;color:#fff;font-size:26px;cursor:pointer;box-shadow:0 10px 25px rgba(0,0,0,.25);z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:transform .15s ease}",
    ".nx-bubble:hover{transform:scale(1.06)}",
    ".nx-panel{position:fixed;right:20px;bottom:88px;width:360px;height:560px;background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.25);z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom right;animation:nxIn .18s ease-out}",
    "@keyframes nxIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}",
    ".nx-header{padding:10px 14px;color:#fff;display:flex;align-items:center;justify-content:space-between;font-weight:600;min-height:52px}",
    ".nx-header-left{display:flex;flex-direction:column;gap:2px}",
    ".nx-header-title{font-size:15px;font-weight:700}",
    ".nx-header-sub{font-size:11px;font-weight:400;opacity:.85;display:flex;align-items:center;gap:5px}",
    ".nx-online-dot{width:7px;height:7px;border-radius:9999px;display:inline-block}",
    ".nx-header-actions{display:flex;align-items:center;gap:6px}",
    ".nx-header-btn{background:rgba(255,255,255,.2);border:none;color:#fff;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center}",
    ".nx-header-btn:hover{background:rgba(255,255,255,.35)}",
    ".nx-tags{padding:8px 12px 4px;display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid #f3f4f6;background:#fff}",
    ".nx-tag{background:#f3f4f6;border:1px solid #e5e7eb;border-radius:20px;padding:4px 10px;font-size:12px;color:#374151;cursor:pointer;white-space:nowrap;transition:all .15s}",
    ".nx-tag:hover{background:#ede9fe;border-color:#8b5cf6;color:#5b21b6}",
    ".nx-msgs{flex:1;overflow-y:auto;padding:14px;background:#f7f8fa;display:flex;flex-direction:column;gap:8px}",
    ".nx-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}",
    ".nx-msg.visitor{align-self:flex-end;color:#fff;border-bottom-right-radius:4px}",
    ".nx-msg.assistant,.nx-msg.ai,.nx-msg.human_agent,.nx-msg.agent,.nx-msg.system{align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
    ".nx-msg.system{background:#f9fafb;color:#6b7280;font-style:italic;font-size:13px}",
    ".nx-recalled{align-self:flex-start;font-size:13px;color:#9ca3af;font-style:italic;padding:4px 8px}",
    ".nx-typing{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;padding:10px 14px;border-radius:12px;display:flex;gap:4px}",
    ".nx-typing span{width:6px;height:6px;background:#9ca3af;border-radius:9999px;animation:nxBounce 1.2s infinite ease-in-out}",
    ".nx-typing span:nth-child(2){animation-delay:.15s}.nx-typing span:nth-child(3){animation-delay:.3s}",
    "@keyframes nxBounce{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-4px);opacity:1}}",
    ".nx-input-area{border-top:1px solid #e5e7eb;background:#fff}",
    ".nx-input-row{padding:8px 10px;display:flex;gap:6px;align-items:center}",
    ".nx-input-icon{background:none;border:none;color:#9ca3af;cursor:pointer;font-size:18px;padding:4px;border-radius:6px;display:flex;align-items:center;justify-content:center}",
    ".nx-input-icon:hover{background:#f3f4f6;color:#6b7280}",
    ".nx-input-icon:disabled{opacity:.4;cursor:not-allowed}",
    ".nx-input-row textarea{flex:1;resize:none;border:1px solid #e5e7eb;border-radius:8px;padding:7px 10px;font-size:14px;outline:none;height:36px;max-height:100px;font-family:inherit}",
    ".nx-input-row textarea:focus{border-color:#9ca3af}",
    ".nx-send{border:none;color:#fff;padding:0 14px;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px;height:36px;min-width:56px}",
    ".nx-send:disabled{opacity:.5;cursor:not-allowed}",
    ".nx-human-btn{width:100%;background:none;border:none;border-top:1px solid #f3f4f6;padding:8px;color:#6b7280;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px}",
    ".nx-human-btn:hover{background:#f9fafb;color:#374151}",
    ".nx-human-btn:disabled{opacity:.4;cursor:not-allowed}",
    ".nx-footer{text-align:center;padding:5px;font-size:11px;color:#d1d5db;background:#fff;border-top:1px solid #f3f4f6}",
    ".nx-resolved{margin:12px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;text-align:center;font-size:13px;color:#166534}",
    ".nx-new-chat{margin-top:10px;background:#6B5CE7;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;font-family:inherit}",
    ".nx-tickets-page{position:absolute;top:0;left:0;right:0;bottom:0;background:#fff;display:flex;flex-direction:column;z-index:10}",
    ".nx-tickets-header{padding:12px 14px;color:#fff;display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px}",
    ".nx-tickets-back{background:rgba(255,255,255,.2);border:none;color:#fff;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center}",
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
    "@media(max-width:420px){.nx-panel{right:8px;left:8px;width:auto;height:min(560px,calc(100dvh - 96px));bottom:80px} .nx-bubble{right:16px;bottom:16px}}",
  ].join("");
  document.head.appendChild(style);

  // ---------- DOM ----------
  var root = document.createElement("div");
  root.className = "nx-root";
  document.body.appendChild(root);

  var bubble = document.createElement("button");
  bubble.className = "nx-bubble";
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.innerHTML = "💬";
  bubble.style.background = "#6B5CE7"; // default until config loads
  root.appendChild(bubble);

  var panel = null;
  var msgsEl, inputEl, sendBtn, typingEl, tagsEl, humanBtn;

  function getPrimary() {
    return (config && config.widget_config && config.widget_config.primary_color) || "#6B5CE7";
  }
  function applyColor(color) { bubble.style.background = color; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function getTicketNo() {
    return state.conversationId ? state.conversationId.substring(0,7) : "-------";
  }
  function getSuggestedQuestions() {
    var defaults = ["Track my order","Shipping fee and delivery?","Cancel order & refund","What's the return policy?","Contact human support"];
    if (!config || !config.widget_config) return defaults;
    var sq = config.widget_config.suggested_questions;
    return (Array.isArray(sq) && sq.length > 0) ? sq : defaults;
  }
  function getOfflineMessage() {
    if (config && config.widget_config && config.widget_config.offline_message)
      return config.widget_config.offline_message;
    return "Our team is currently offline.\nWe\u2019ll reply during office hours.";
  }

  function buildPanel() {
    var primary = getPrimary();
    var title   = (config && config.widget_config && config.widget_config.header_title) || "Customer Support";
    var placeholder = (config && config.widget_config && config.widget_config.placeholder_text) || "Type a message\u2026";
    var online  = state.online;

    panel = document.createElement("div");
    panel.className = "nx-panel";
    panel.innerHTML =
      '<div class="nx-header" style="background:' + primary + '">' +
        '<div class="nx-header-left">' +
          '<div class="nx-header-title">' + escapeHtml(title) + '</div>' +
          '<div class="nx-header-sub">' +
            '<span class="nx-online-dot" style="background:' + (online ? "#4ade80" : "#9ca3af") + '"></span>' +
            (online ? "Online" : "Offline") +
            ' &nbsp;&middot;&nbsp; Chat #<span id="nx-ticket-no">' + getTicketNo() + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="nx-header-actions">' +
          '<button class="nx-header-btn" id="nx-my-tickets-btn" title="My Tickets" aria-label="My Tickets">&#9783;</button>' +
          '<button class="nx-header-btn" id="nx-close-btn" title="Close" aria-label="Close">&times;</button>' +
        '</div>' +
      '</div>' +
      '<div id="nx-tags-area" class="nx-tags" style="display:none"></div>' +
      '<div class="nx-msgs"></div>' +
      '<div class="nx-input-area">' +
        '<div class="nx-input-row">' +
          '<button class="nx-input-icon" id="nx-upload-btn" title="Attach file (coming soon)" disabled>&#128206;</button>' +
          '<textarea id="nx-input" placeholder="' + escapeHtml(placeholder) + '" rows="1"></textarea>' +
          '<button class="nx-send" id="nx-send" type="button" style="background:' + primary + '">Send</button>' +
        '</div>' +
        '<button class="nx-human-btn" id="nx-human-btn">&#128100; Request Human Support</button>' +
      '</div>' +
      '<div class="nx-footer">Powered by NexusAI</div>';
    root.appendChild(panel);

    msgsEl   = panel.querySelector(".nx-msgs");
    inputEl  = panel.querySelector("#nx-input");
    sendBtn  = panel.querySelector("#nx-send");
    tagsEl   = panel.querySelector("#nx-tags-area");
    humanBtn = panel.querySelector("#nx-human-btn");

    panel.querySelector("#nx-close-btn").addEventListener("click", closePanel);
    panel.querySelector("#nx-my-tickets-btn").addEventListener("click", showMyTicketsPage);
    panel.querySelector("#nx-upload-btn").addEventListener("click", function() {
      alert("File upload coming soon.");
    });
    sendBtn.addEventListener("click", handleSend);
    inputEl.addEventListener("keydown", function(e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    humanBtn.addEventListener("click", handleHumanSupportRequest);

    showSuggestedQuestions();
  }

  function updateHeader() {
    if (!panel) return;
    var no = panel.querySelector("#nx-ticket-no");
    if (no) no.textContent = getTicketNo();
  }

  // ---------- Suggested Questions ----------
  function showSuggestedQuestions() {
    if (!tagsEl || state.firstMessageSent) return;
    var questions = getSuggestedQuestions();
    if (!questions.length) return;
    tagsEl.innerHTML = "";
    questions.forEach(function(q) {
      var btn = document.createElement("button");
      btn.className = "nx-tag";
      btn.textContent = q;
      btn.addEventListener("click", function() {
        if (inputEl) { inputEl.value = q; }
        hideSuggestedQuestions();
        handleSend();
      });
      tagsEl.appendChild(btn);
    });
    tagsEl.style.display = "flex";
  }
  function hideSuggestedQuestions() {
    if (tagsEl) tagsEl.style.display = "none";
    state.firstMessageSent = true;
  }

  // ---------- Request Human Support ----------
  function handleHumanSupportRequest() {
    if (!state.sessionToken || !state.conversationId) return;
    if (state.handoffRequested) return;
    state.handoffRequested = true;
    humanBtn.disabled = true;

    // MVP-A: use existing receive-widget-message (no new EF needed)
    api("/receive-widget-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: state.conversationId,
        session_token: state.sessionToken,
        content: "I\u2019d like to speak with a human agent."
      })
    }).catch(function() {});

    // Show waiting message in UI immediately
    appendMessageObj({
      id: "system-handoff-" + Date.now(),
      role: "system",
      content: "We\u2019re connecting you to a team member.\nEstimated wait time: 2\u20135 minutes.",
      created_at: new Date().toISOString()
    });
  }

  // ---------- My Tickets Page ----------
  function showMyTicketsPage() {
    if (!panel) return;
    var primary = getPrimary();
    var page = document.createElement("div");
    page.className = "nx-tickets-page";
    page.id = "nx-tickets-page";

    var tickets = getTicketHistory();
    var listHtml = "";
    if (tickets.length === 0) {
      listHtml = '<div class="nx-tickets-empty">&#128203; No previous tickets</div>';
    } else {
      tickets.forEach(function(t) {
        var statusLabel = t.status === "resolved" ? "Resolved"
          : t.status === "human_needed" ? "Waiting" : "Open";
        listHtml +=
          '<div class="nx-ticket-item" data-conv="' + escapeHtml(t.conversation_id) + '" data-token="' + escapeHtml(t.session_token) + '">' +
            '<div class="nx-ticket-row">' +
              '<span class="nx-ticket-no">Chat #' + escapeHtml(t.ticket_no) + '</span>' +
              '<span class="nx-ticket-status ' + escapeHtml(t.status) + '">' + statusLabel + '</span>' +
            '</div>' +
            '<div class="nx-ticket-preview">' + escapeHtml(t.last_message || "(no messages yet)") + '</div>' +
            '<div class="nx-ticket-time">' + new Date(t.updated_at).toLocaleDateString() + '</div>' +
          '</div>';
      });
    }

    page.innerHTML =
      '<div class="nx-tickets-header" style="background:' + primary + '">' +
        '<button class="nx-tickets-back" id="nx-tickets-back">&larr;</button>' +
        'My Tickets' +
      '</div>' +
      '<div class="nx-tickets-list">' + listHtml + '</div>' +
      '<button class="nx-tickets-new" id="nx-tickets-new">+ Start New Conversation</button>';

    panel.appendChild(page);

    page.querySelector("#nx-tickets-back").addEventListener("click", function() {
      page.remove();
    });
    page.querySelector("#nx-tickets-new").addEventListener("click", function() {
      page.remove();
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
      stopPolling();
      if (inputEl) { inputEl.disabled = false; }
      if (sendBtn) sendBtn.disabled = false;
      if (humanBtn) humanBtn.disabled = false;
      startFreshSession();
    });

    page.querySelectorAll(".nx-ticket-item").forEach(function(item) {
      item.addEventListener("click", function() {
        var convId = item.getAttribute("data-conv");
        var token  = item.getAttribute("data-token");
        page.remove();
        tryRestoreSession({ convId: convId, token: token });
      });
    });
  }

  // ---------- Message rendering ----------
  function renderMsg(m) {
    if (m.is_recalled) {
      var el = document.createElement("div");
      el.className = "nx-recalled";
      el.textContent = "[\u8a0a\u606f\u5df2\u64a4\u56de]";
      return el;
    }
    var el = document.createElement("div");
    el.className = "nx-msg " + (m.role || "assistant");
    if (m.role === "visitor") el.style.background = getPrimary();
    el.textContent = m.content;
    return el;
  }

  function isLocalMessageId(id) {
    var s = String(id || "");
    return s.indexOf("system-") === 0 || s.indexOf("fallback-") === 0 || s === "welcome";
  }

    function appendMessageObj(m) {
    if (!msgsEl) return;
    if (m.content === "__THINKING__") return;
    if (seenIds[m.id]) return;
    seenIds[m.id] = true;
    var idx = state.messages.findIndex(function(x){ return x.id === m.id; });
    if (idx >= 0) state.messages[idx] = m;
    else state.messages.push(m);
    var el = renderMsg(m);
    if (typingEl && typingEl.parentNode === msgsEl) {
      msgsEl.insertBefore(el, typingEl);
    } else {
      msgsEl.appendChild(el);
    }
    if (!isLocalMessageId(m.id)) {
      lastMessageId = m.id;
      // Update last_message in ticket history
      if (m.role !== "system") {
        updateTicketInHistory(state.conversationId, null, m.content.substring(0, 80));
      }
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function appendWelcome() {
    var w = config && config.widget_config && config.widget_config.welcome_message;
    if (!w && !state.online) w = getOfflineMessage();
    if (w) appendMessageObj({ id: "welcome", role: "assistant", content: w });
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
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
  }

  // ---------- Resolved banner ----------
  function showResolvedBanner(messages) {
    if (!msgsEl) return;
    msgsEl.innerHTML = "";
    seenIds = {};
    state.messages = [];
    lastMessageId = null;
    state.firstMessageSent = true;
    hideSuggestedQuestions();

    (messages || []).forEach(function(m) { appendMessageObj(m); });

    var banner = document.createElement("div");
    banner.className = "nx-resolved";
    banner.innerHTML = "\u2705 This conversation has been resolved.<br>" +
      '<button class="nx-new-chat">Start new conversation</button>';
    msgsEl.appendChild(banner);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    if (inputEl) { inputEl.disabled = true; inputEl.placeholder = "Conversation resolved."; }
    if (sendBtn) sendBtn.disabled = true;
    if (humanBtn) humanBtn.disabled = true;

    updateTicketInHistory(state.conversationId, "resolved", null);

    banner.querySelector(".nx-new-chat").addEventListener("click", function() {
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
      stopPolling();
      if (inputEl) { inputEl.disabled = false; inputEl.placeholder = (config && config.widget_config && config.widget_config.placeholder_text) || "Type a message\u2026"; }
      if (sendBtn) sendBtn.disabled = false;
      if (humanBtn) { humanBtn.disabled = false; state.handoffRequested = false; }
      startFreshSession();
    });
  }

  // ---------- API ----------
  function api(path, opts) {
    return fetch(apiBase + path, opts).then(function(r) {
      return r.json().then(function(j) { return { ok: r.ok, status: r.status, body: j }; });
    });
  }

  // ---------- Polling ----------
  function startPolling() {
    if (state.pollInterval) return;
    state.pollInterval = setInterval(poll, 2500);
  }
  function stopPolling() {
    if (state.pollInterval) { clearInterval(state.pollInterval); state.pollInterval = null; }
  }

  function poll() {
    if (!state.conversationId || !state.sessionToken) return;
    var qs = "?conversation_id=" + encodeURIComponent(state.conversationId) +
             "&session_token=" + encodeURIComponent(state.sessionToken) +
             (lastMessageId ? "&after_message_id=" + encodeURIComponent(lastMessageId) : "");
    api("/widget-poll-messages" + qs, { method: "GET" }).then(function(res) {
      if (!res.ok || !res.body || !res.body.success) return;
      var d = res.body.data;

      // Handle resolved
      if (d.conversation_status === "resolved") {
        hideTyping();
        stopPolling();
        var newMsgs = d.messages || [];
        newMsgs.forEach(function(m) {
          if (!state.messages.some(function(x){ return x.id === m.id; })) state.messages.push(m);
        });
        var merged = state.messages
          .filter(function(m){ return m.content !== "__THINKING__"; })
          .filter(function(m, i, arr){ return arr.findIndex(function(x){ return x.id === m.id; }) === i; })
          .sort(function(a,b){ return new Date(a.created_at) - new Date(b.created_at); });
        showResolvedBanner(merged);
        return;
      }

      (d.messages || []).forEach(function(m) {
        appendMessageObj(m);
        if (m.role === "visitor") hideSuggestedQuestions();
      });

      var ai_generating = d.ai_generating;
      // Fix 1: suppress AI typing when human support was requested
      if (ai_generating && state.handoffRequested) {
        hideTyping();
        state.thinkingStartTime = null;
        state.fallbackShownForConversation = true;
        return;
      }
      if (ai_generating) {
        if (!state.fallbackShownForConversation) {
          if (!state.thinkingStartTime) state.thinkingStartTime = Date.now();
          if (!document.getElementById("nexus-typing-indicator")) showTyping();
          if (Date.now() - state.thinkingStartTime > 60000) {
            hideTyping();
            state.thinkingStartTime = null;
            state.fallbackShownForConversation = true;
            appendMessageObj({ id: "fallback-" + Date.now(), role: "system",
              content: "Your message was received. Our team will reply shortly.",
              created_at: new Date().toISOString() });
          }
        }
      } else {
        state.thinkingStartTime = null;
        state.fallbackShownForConversation = false;
        hideTyping();
      }
    }).catch(function() {});
  }

  // ---------- Session ----------
  function startFreshSession() {
    if (msgsEl) msgsEl.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:20px;font-size:13px;">Connecting\u2026</div>';
    state.messages = [];
    seenIds = {};
    lastMessageId = null;
    api("/create-visitor-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId })
    }).then(function(s) {
      if (!s.ok || !s.body || !s.body.success) {
        if (msgsEl) msgsEl.innerHTML = '<div style="text-align:center;color:#ef4444;padding:20px;font-size:13px;">Unable to start session.</div>';
        return;
      }
      state.sessionToken   = s.body.data.session_token;
      state.conversationId = s.body.data.conversation_id;
      saveSession();
      saveTicketToHistory(state.conversationId, state.sessionToken);
      updateHeader();
      if (msgsEl) msgsEl.innerHTML = "";
      state.online = isOnline();
      appendWelcome();
      showSuggestedQuestions();
      startPolling();
    }).catch(function() {
      if (msgsEl) msgsEl.innerHTML = '<div style="text-align:center;color:#ef4444;padding:20px;font-size:13px;">Connection failed.</div>';
    });
  }

  function tryRestoreSession(stored) {
    if (msgsEl) msgsEl.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:20px;font-size:13px;">Resuming\u2026</div>';
    hideSuggestedQuestions();
    var qs = "?conversation_id=" + encodeURIComponent(stored.convId) +
             "&session_token=" + encodeURIComponent(stored.token);
    api("/widget-poll-messages" + qs, { method: "GET" }).then(function(res) {
      if (!res.ok || !res.body || !res.body.success) throw new Error("restore failed");
      var d = res.body.data;
      state.sessionToken   = stored.token;
      state.conversationId = stored.convId;
      saveSession(); // Fix 3: persist restored session so refresh returns here
      saveTicketToHistory(state.conversationId, state.sessionToken);
      state.messages = [];
      seenIds = {};
      lastMessageId = null;
      if (msgsEl) msgsEl.innerHTML = "";
      updateHeader();
      if (d.conversation_status === "resolved") {
        showResolvedBanner(d.messages || []);
      } else {
        var msgs = d.messages || [];
        if (msgs.length === 0) { appendWelcome(); showSuggestedQuestions(); }
        else {
          msgs.forEach(function(m){ appendMessageObj(m); });
          state.firstMessageSent = true;
        }
        startPolling();
      }
    }).catch(function() {
      clearSession();
      state.sessionToken = null;
      state.conversationId = null;
      startFreshSession();
    });
  }

  // ---------- Open / Close ----------
  function openPanel() {
    if (panel && panel.style.display !== "none") return;
    if (panel && state.sessionToken) { panel.style.display = "flex"; startPolling(); return; }
    var configPromise = config ? Promise.resolve()
      : api("/get-public-widget-config?channel_id=" + encodeURIComponent(channelId), { method: "GET" })
          .then(function(res) {
            if (!res.ok || !res.body || !res.body.success) throw new Error("config failed");
            config = res.body.data;
            state.online = isOnline();
            applyColor(getPrimary());
          });
    configPromise.then(function() {
      if (!panel) buildPanel();
      panel.style.display = "flex";
      var stored = loadSession();
      if (stored.token && stored.convId && stored.channel === channelId) {
        tryRestoreSession(stored);
      } else {
        startFreshSession();
      }
    }).catch(function() {
      if (msgsEl) msgsEl.innerHTML = '<div style="text-align:center;color:#ef4444;padding:20px;font-size:13px;">Chat unavailable.</div>';
    });
  }

  function closePanel() {
    if (panel) panel.style.display = "none";
    stopPolling();
  }

  // ---------- Send ----------
  function handleSend() {
    if (!inputEl) return;
    var text = inputEl.value.trim();
    if (!text || !state.conversationId || !state.sessionToken) return;
    if (text.length > 2000) { alert("Message too long (max 2000 characters)."); return; }
    hideSuggestedQuestions();
    sendBtn.disabled = true;
    sendBtn.textContent = "\u2026";
    inputEl.value = "";
    api("/receive-widget-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: state.conversationId, session_token: state.sessionToken, content: text })
    }).then(function(res) {
      if (!res.ok || !res.body || !res.body.success) {
        appendMessageObj({ id: "err-" + Date.now(), role: "system",
          content: (res.body && res.body.error) || "Failed to send.",
          created_at: new Date().toISOString() });
      }
    }).catch(function() {
      appendMessageObj({ id: "err-" + Date.now(), role: "system",
        content: "Network error.", created_at: new Date().toISOString() });
    }).then(function() {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send";
      state.fallbackShownForConversation = false;
      state.thinkingStartTime = null;
      if (!state.pollInterval && state.conversationId) startPolling();
    });
  }

  // ---------- Bubble ----------
  bubble.addEventListener("click", function() {
    if (panel && panel.style.display !== "none") closePanel();
    else openPanel();
  });

  // Pre-load config to colour bubble
  api("/get-public-widget-config?channel_id=" + encodeURIComponent(channelId), { method: "GET" })
    .then(function(res) {
      if (res.ok && res.body && res.body.success && res.body.data && res.body.data.widget_config) {
        config = res.body.data;
        state.online = isOnline();
        applyColor(getPrimary());
      }
    }).catch(function() {});

  console.log("[NexusAI widget] Widget MVP v1.1 loaded, channel:", channelId);
})();
