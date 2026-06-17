/* NexusAI embeddable chat widget — vanilla JS, zero deps — L2.1 session persistence */
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

  var STORAGE_PREFIX = "nexus_widget_" + channelId;
  var SK_TOKEN   = STORAGE_PREFIX + "_session_token";
  var SK_CONV    = STORAGE_PREFIX + "_conversation_id";
  var SK_CHANNEL = STORAGE_PREFIX + "_channel_id";

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

  var config = null;
  var lastMessageId = null;
  var seenIds = {};
  var state = {
    sessionToken: null,
    conversationId: null,
    pollInterval: null,
    thinkingStartTime: null,
    fallbackShownForConversation: false,
    messages: [],
  };

  var style = document.createElement("style");
  style.textContent = [
    ".nx-root *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".nx-bubble{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:9999px;border:none;color:#fff;font-size:26px;cursor:pointer;box-shadow:0 10px 25px rgba(0,0,0,.25);z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:transform .15s ease}",
    ".nx-bubble:hover{transform:scale(1.06)}",
    ".nx-panel{position:fixed;right:20px;bottom:88px;width:360px;height:520px;background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.25);z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom right;animation:nxIn .18s ease-out}",
    "@keyframes nxIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}",
    ".nx-header{padding:14px 16px;color:#fff;display:flex;align-items:center;justify-content:space-between;font-weight:600}",
    ".nx-close{background:transparent;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:0 4px}",
    ".nx-msgs{flex:1;overflow-y:auto;padding:14px;background:#f7f8fa;display:flex;flex-direction:column;gap:8px}",
    ".nx-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}",
    ".nx-msg.visitor{align-self:flex-end;color:#fff;border-bottom-right-radius:4px}",
    ".nx-msg.assistant,.nx-msg.ai,.nx-msg.system,.nx-msg.agent,.nx-msg.human_agent{align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
    ".nx-recalled{align-self:flex-start;font-size:13px;color:#9ca3af;font-style:italic;padding:4px 8px}",
    ".nx-typing{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;padding:10px 14px;border-radius:12px;display:flex;gap:4px}",
    ".nx-typing span{width:6px;height:6px;background:#9ca3af;border-radius:9999px;animation:nxBounce 1.2s infinite ease-in-out}",
    ".nx-typing span:nth-child(2){animation-delay:.15s}.nx-typing span:nth-child(3){animation-delay:.3s}",
    "@keyframes nxBounce{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-4px);opacity:1}}",
    ".nx-input{border-top:1px solid #e5e7eb;padding:10px;display:flex;gap:8px;background:#fff}",
    ".nx-input textarea{flex:1;resize:none;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:14px;outline:none;height:38px;max-height:100px;font-family:inherit}",
    ".nx-input textarea:focus{border-color:#9ca3af}",
    ".nx-send{border:none;color:#fff;padding:0 14px;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px}",
    ".nx-send:disabled{opacity:.5;cursor:not-allowed}",
    ".nx-footer{text-align:center;padding:6px;font-size:11px;color:#9ca3af;background:#fff;border-top:1px solid #f3f4f6}",
    ".nx-resolved{margin:12px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;text-align:center;font-size:13px;color:#166534}",
    ".nx-new-chat{margin-top:10px;background:#6B5CE7;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;font-family:inherit}",
  ].join("");
  document.head.appendChild(style);

  var root = document.createElement("div");
  root.className = "nx-root";
  document.body.appendChild(root);

  var bubble = document.createElement("button");
  bubble.className = "nx-bubble";
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.innerHTML = "💬";
  root.appendChild(bubble);

  var panel = null;
  var msgsEl, inputEl, sendBtn, typingEl;

  function getPrimary() {
    return (config && config.widget_config && config.widget_config.primary_color) || "#6B5CE7";
  }
  function applyColor(color) { bubble.style.background = color; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {"&":"&amp;","<":"&lt;","&gt;":"&gt;","'":"&#39;"}[c];
    });
  }

  function buildPanel() {
    var primary = getPrimary();
    var title = (config && config.widget_config && config.widget_config.header_title) || "Customer Support";
    var placeholder = (config && config.widget_config && config.widget_config.placeholder_text) || "Type a message…";
    panel = document.createElement("div");
    panel.className = "nx-panel";
    panel.innerHTML =
      '<div class="nx-header" style="background:' + primary + '">' +
        '<span>' + escapeHtml(title) + '</span>' +
        '<button class="nx-close" type="button" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="nx-msgs"></div>' +
      '<div class="nx-input">' +
        '<textarea placeholder="' + escapeHtml(placeholder) + '" rows="1"></textarea>' +
        '<button class="nx-send" type="button" style="background:' + primary + '">Send</button>' +
      '</div>' +
      '<div class="nx-footer">Powered by NexusAI</div>';
    root.appendChild(panel);
    msgsEl  = panel.querySelector(".nx-msgs");
    inputEl = panel.querySelector("textarea");
    sendBtn = panel.querySelector(".nx-send");
    panel.querySelector(".nx-close").addEventListener("click", closePanel);
    sendBtn.addEventListener("click", handleSend);
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
  }

  function renderMsg(m) {
    if (m.is_recalled) {
      var el = document.createElement("div");
      el.className = "nx-recalled";
      el.textContent = "[訊息已撤回]";
      return el;
    }
    var el = document.createElement("div");
    el.className = "nx-msg " + (m.role || "assistant");
    if (m.role === "visitor") el.style.background = getPrimary();
    el.textContent = m.content;
    return el;
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
    if (m.id !== "welcome") lastMessageId = m.id;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function appendWelcome() {
    var welcome = config && config.widget_config && config.widget_config.welcome_message;
    if (welcome) appendMessageObj({ id: "welcome", role: "assistant", content: welcome });
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

  function showResolvedBanner(messages) {
    if (!msgsEl) return;
    msgsEl.innerHTML = "";
    seenIds = {};
    state.messages = [];
    lastMessageId = null;
    (messages || []).forEach(function(m) { appendMessageObj(m); });
    var banner = document.createElement("div");
    banner.className = "nx-resolved";
    banner.innerHTML = "✅ This conversation has been resolved.<br>" +
      '<button class="nx-new-chat">Start new conversation</button>';
    msgsEl.appendChild(banner);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    if (inputEl) { inputEl.disabled = true; inputEl.placeholder = "Conversation resolved."; }
    if (sendBtn) sendBtn.disabled = true;
    banner.querySelector(".nx-new-chat").addEventListener("click", function() {
      clearSession();
      state.sessionToken = null;
      state.conversationId = null;
      state.messages = [];
      state.fallbackShownForConversation = false;
      state.thinkingStartTime = null;
      seenIds = {};
      lastMessageId = null;
      stopPolling();
      if (inputEl) { inputEl.disabled = false; inputEl.placeholder = (config && config.widget_config && config.widget_config.placeholder_text) || "Type a message…"; }
      if (sendBtn) sendBtn.disabled = false;
      startFreshSession();
    });
  }

  function api(path, opts) {
    return fetch(apiBase + path, opts).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    });
  }

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
    api("/widget-poll-messages" + qs, { method: "GET" }).then(function (res) {
      if (!res.ok || !res.body || !res.body.success) return;
      var d = res.body.data;
      if (d.conversation_status === "resolved") {
        hideTyping();
        stopPolling();
        var newMsgs = d.messages || [];
        newMsgs.forEach(function(m) {
          var exists = state.messages.some(function(x){ return x.id === m.id; });
          if (!exists) state.messages.push(m);
        });
        var merged = state.messages
          .filter(function(m){ return m.content !== "__THINKING__"; })
          .filter(function(m, i, arr){ return arr.findIndex(function(x){ return x.id === m.id; }) === i; })
          .sort(function(a,b){ return new Date(a.created_at) - new Date(b.created_at); });
        showResolvedBanner(merged);
        return;
      }
      (d.messages || []).forEach(function (m) { appendMessageObj(m); });
      var ai_generating = d.ai_generating;
      if (ai_generating) {
        if (!state.fallbackShownForConversation) {
          if (!state.thinkingStartTime) state.thinkingStartTime = Date.now();
          if (!document.getElementById("nexus-typing-indicator")) showTyping();
          if (Date.now() - state.thinkingStartTime > 60000) {
            hideTyping();
            state.thinkingStartTime = null;
            state.fallbackShownForConversation = true;
            appendMessageObj({ id: "fallback-" + Date.now(), role: "assistant",
              content: "Your message was received. AI reply not available yet. [L2 dev mode]",
              created_at: new Date().toISOString() });
          }
        }
      } else {
        state.thinkingStartTime = null;
        state.fallbackShownForConversation = false;
        hideTyping();
      }
    }).catch(function () {});
  }

  function startFreshSession() {
    if (msgsEl) {
      msgsEl.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:20px;font-size:13px;">Connecting…</div>';
    }
    state.messages = [];
    seenIds = {};
    lastMessageId = null;
    api("/create-visitor-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId }),
    }).then(function (s) {
      if (!s.ok || !s.body || !s.body.success) {
        if (msgsEl) msgsEl.innerHTML = '<div style="text-align:center;color:#ef4444;padding:20px;font-size:13px;">Unable to start chat session.</div>';
        return;
      }
      state.sessionToken   = s.body.data.session_token;
      state.conversationId = s.body.data.conversation_id;
      saveSession();
      if (msgsEl) msgsEl.innerHTML = "";
      appendWelcome();
      startPolling();
    }).catch(function () {
      if (msgsEl) msgsEl.innerHTML = '<div style="text-align:center;color:#ef4444;padding:20px;font-size:13px;">Connection failed.</div>';
    });
  }

  function tryRestoreSession(stored) {
    if (msgsEl) {
      msgsEl.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:20px;font-size:13px;">Resuming conversation…</div>';
    }
    var qs = "?conversation_id=" + encodeURIComponent(stored.convId) +
             "&session_token=" + encodeURIComponent(stored.token);
    api("/widget-poll-messages" + qs, { method: "GET" }).then(function(res) {
      if (!res.ok || !res.body || !res.body.success) throw new Error("restore failed");
      var d = res.body.data;
      state.sessionToken   = stored.token;
      state.conversationId = stored.convId;
      state.messages = [];
      seenIds = {};
      lastMessageId = null;
      if (msgsEl) msgsEl.innerHTML = "";
      if (d.conversation_status === "resolved") {
        showResolvedBanner(d.messages || []);
      } else {
        var msgs = d.messages || [];
        if (msgs.length === 0) {
          appendWelcome();
        } else {
          msgs.forEach(function(m){ appendMessageObj(m); });
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

  function openPanel() {
    if (panel && panel.style.display !== "none") return;
    if (panel && state.sessionToken) {
      panel.style.display = "flex";
      startPolling();
      return;
    }
    var configPromise = config
      ? Promise.resolve()
      : api("/get-public-widget-config?channel_id=" + encodeURIComponent(channelId), { method: "GET" })
          .then(function (res) {
            if (!res.ok || !res.body || !res.body.success) throw new Error("config failed");
            config = res.body.data;
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

  function handleSend() {
    if (!inputEl) return;
    var text = inputEl.value.trim();
    if (!text || !state.conversationId || !state.sessionToken) return;
    if (text.length > 2000) { alert("Message too long (max 2000)."); return; }
    sendBtn.disabled = true;
    inputEl.value = "";
    api("/receive-widget-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: state.conversationId, session_token: state.sessionToken, content: text }),
    }).then(function (res) {
      if (!res.ok || !res.body || !res.body.success) {
        appendMessageObj({ id: "err-" + Date.now(), role: "system", content: (res.body && res.body.error) || "Failed to send.", created_at: new Date().toISOString() });
      }
    }).catch(function () {
      appendMessageObj({ id: "err-" + Date.now(), role: "system", content: "Network error.", created_at: new Date().toISOString() });
    }).then(function () {
      sendBtn.disabled = false;
      state.fallbackShownForConversation = false;
      state.thinkingStartTime = null;
      if (!state.pollInterval && state.conversationId) startPolling();
    });
  }

  bubble.addEventListener("click", function () {
    if (panel && panel.style.display !== "none") closePanel();
    else openPanel();
  });

  api("/get-public-widget-config?channel_id=" + encodeURIComponent(channelId), { method: "GET" })
    .then(function (res) {
      if (res.ok && res.body && res.body.success && res.body.data && res.body.data.widget_config) {
        applyColor(res.body.data.widget_config.primary_color || "#6B5CE7");
      }
    }).catch(function () {});
})();