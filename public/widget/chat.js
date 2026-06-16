/* NexusAI embeddable chat widget — vanilla JS, zero deps */
(function () {
  if (window.__nexusChatLoaded) return;
  window.__nexusChatLoaded = true;

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName("script");
    return s[s.length - 1];
  })();
  var CHANNEL_ID = script.getAttribute("data-channel-id");
  var apiBase = (script.getAttribute("data-api-base") || "").replace(/\/$/, "");
  if (!CHANNEL_ID || !apiBase) {
    console.error("[NexusAI] data-channel-id and data-api-base are required");
    return;
  }

  // Session token is not a Supabase auth token, but it is a visitor-scoped bearer token
  // that can access one visitor conversation. Treat as low-sensitivity.
  // localStorage keys are scoped per CHANNEL_ID to prevent cross-widget conflicts.
  var STORAGE_PREFIX = "nexus_widget_" + CHANNEL_ID;
  var STORAGE_KEY_SESSION_TOKEN   = STORAGE_PREFIX + "_session_token";
  var STORAGE_KEY_SESSION_ID      = STORAGE_PREFIX + "_session_id";
  var STORAGE_KEY_CONVERSATION_ID = STORAGE_PREFIX + "_conversation_id";
  var STORAGE_KEY_CHANNEL_ID      = STORAGE_PREFIX + "_channel_id";

  function saveSessionToStorage() {
    try {
      if (state.sessionToken) localStorage.setItem(STORAGE_KEY_SESSION_TOKEN, state.sessionToken);
      if (state.sessionId) localStorage.setItem(STORAGE_KEY_SESSION_ID, state.sessionId);
      if (state.conversationId) localStorage.setItem(STORAGE_KEY_CONVERSATION_ID, state.conversationId);
      localStorage.setItem(STORAGE_KEY_CHANNEL_ID, CHANNEL_ID);
    } catch (e) {}
  }
  function clearSessionFromStorage() {
    try {
      localStorage.removeItem(STORAGE_KEY_SESSION_TOKEN);
      localStorage.removeItem(STORAGE_KEY_SESSION_ID);
      localStorage.removeItem(STORAGE_KEY_CONVERSATION_ID);
      localStorage.removeItem(STORAGE_KEY_CHANNEL_ID);
    } catch (e) {}
  }
  function loadSessionFromStorage() {
    try {
      return {
        sessionToken: localStorage.getItem(STORAGE_KEY_SESSION_TOKEN),
        sessionId: localStorage.getItem(STORAGE_KEY_SESSION_ID),
        conversationId: localStorage.getItem(STORAGE_KEY_CONVERSATION_ID),
        channelId: localStorage.getItem(STORAGE_KEY_CHANNEL_ID),
      };
    } catch (e) {
      return { sessionToken: null, sessionId: null, conversationId: null, channelId: null };
    }
  }

  var config = null;
  var lastMessageId = null;
  var seenIds = {};
  var state = {
    sessionToken: null,
    sessionId: null,
    conversationId: null,
    pollInterval: null,
    thinkingStartTime: null,
    fallbackShownForConversation: false,
    messages: [],
  };

  // ---------- Styles ----------
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
    ".nx-msg.assistant,.nx-msg.system,.nx-msg.agent{align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
    ".nx-typing{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;padding:10px 14px;border-radius:12px;display:flex;gap:4px}",
    ".nx-typing span{width:6px;height:6px;background:#9ca3af;border-radius:9999px;animation:nxBounce 1.2s infinite ease-in-out}",
    ".nx-typing span:nth-child(2){animation-delay:.15s}.nx-typing span:nth-child(3){animation-delay:.3s}",
    "@keyframes nxBounce{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-4px);opacity:1}}",
    ".nx-input{border-top:1px solid #e5e7eb;padding:10px;display:flex;gap:8px;background:#fff}",
    ".nx-input textarea{flex:1;resize:none;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:14px;outline:none;height:38px;max-height:100px;font-family:inherit}",
    ".nx-input textarea:focus{border-color:#9ca3af}",
    ".nx-send{border:none;color:#fff;padding:0 14px;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px}",
    ".nx-send:disabled{opacity:.5;cursor:not-allowed}",
    ".nx-status{padding:8px 12px;background:#f0fdf4;border-bottom:1px solid #bbf7d0;color:#15803d;font-size:12px;text-align:center}",
    ".nx-footer{text-align:center;padding:6px;font-size:11px;color:#9ca3af;background:#fff;border-top:1px solid #f3f4f6}",
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
  root.appendChild(bubble);

  var panel = null;
  var msgsEl, inputEl, sendBtn, typingEl;

  function applyColor(color) {
    bubble.style.background = color;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function buildPanel() {
    var primary = (config && config.widget_config && config.widget_config.primary_color) || "#111827";
    var title = (config && config.widget_config && config.widget_config.header_title) || "Chat";
    var placeholder = (config && config.widget_config && config.widget_config.placeholder_text) || "Type a message…";

    panel = document.createElement("div");
    panel.className = "nx-panel";
    panel.innerHTML =
      '<div class="nx-header" style="background:' + primary + '">' +
        '<span>' + escapeHtml(title) + '</span>' +
        '<button class="nx-close" type="button" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="nx-msgs" id="nexus-messages"></div>' +
      '<div class="nx-input">' +
        '<textarea id="nexus-input" placeholder="' + escapeHtml(placeholder) + '" rows="1"></textarea>' +
        '<button class="nx-send" id="nexus-send" type="button" style="background:' + primary + '">Send</button>' +
      '</div>' +
      '<div class="nx-footer">Powered by NexusAI</div>';
    root.appendChild(panel);

    msgsEl = panel.querySelector(".nx-msgs");
    inputEl = panel.querySelector("textarea");
    sendBtn = panel.querySelector(".nx-send");

    panel.querySelector(".nx-close").addEventListener("click", closePanel);
    sendBtn.addEventListener("click", handleSend);
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
  }

  function appendMessage(role, content, id) {
    if (id) {
      if (seenIds[id]) return;
      seenIds[id] = true;
    }
    var el = document.createElement("div");
    el.className = "nx-msg " + role;
    if (role === "visitor") {
      var primary = (config && config.widget_config && config.widget_config.primary_color) || "#111827";
      el.style.background = primary;
    }
    el.textContent = content;
    if (typingEl && typingEl.parentNode === msgsEl) {
      msgsEl.insertBefore(el, typingEl);
    } else {
      msgsEl.appendChild(el);
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function showTyping() {
    if (!typingEl) {
      typingEl = document.createElement("div");
      typingEl.className = "nx-typing";
      typingEl.id = "nexus-typing-indicator";
      typingEl.innerHTML = "<span></span><span></span><span></span>";
    }
    if (typingEl.parentNode !== msgsEl) {
      msgsEl.appendChild(typingEl);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  }
  function hideTyping() {
    if (typingEl && typingEl.parentNode === msgsEl) msgsEl.removeChild(typingEl);
  }

  function appendMessageObj(m) {
    appendMessage(m.role, m.content, m.id);
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
      if (!res.ok || !res.body || !res.body.success) {
        if (res.status === 401 || res.status === 404) {
          // Stored session no longer valid — clear and restart fresh
          stopPolling();
          clearSessionFromStorage();
          state.sessionToken = null;
          state.sessionId = null;
          state.conversationId = null;
          lastMessageId = null;
          seenIds = {};
        }
        return;
      }
      var d = res.body.data;
      (d.messages || []).forEach(function (m) {
        appendMessageObj(m);
        lastMessageId = m.id;
      });

      var ai_generating = d.ai_generating;
      if (ai_generating) {
        if (!state.fallbackShownForConversation) {
          if (!state.thinkingStartTime) state.thinkingStartTime = Date.now();
          if (!document.getElementById('nexus-typing-indicator')) showTyping();
          if (Date.now() - state.thinkingStartTime > 60000) {
            hideTyping();
            state.thinkingStartTime = null;
            state.fallbackShownForConversation = true;
            appendMessage('assistant', 'Your message was received. AI reply not available yet. [L2 dev mode]', 'fallback-' + Date.now());
          }
        }
      } else {
        state.thinkingStartTime = null;
        state.fallbackShownForConversation = false;
        hideTyping();
      }
    }).catch(function () {});
  }

  function createSession() {
    return api("/create-visitor-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: CHANNEL_ID }),
    }).then(function (s) {
      if (!s.ok || !s.body || !s.body.success) {
        throw new Error((s.body && s.body.error) || "Failed to create session");
      }
      return s.body.data;
    });
  }

  function startFreshSession() {
    if (msgsEl) {
      msgsEl.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:20px;font-size:13px;">Connecting…</div>';
    }
    return createSession().then(function (data) {
      state.sessionToken = data.session_token;
      state.sessionId = data.session_id || null;
      state.conversationId = data.conversation_id;
      lastMessageId = null;
      seenIds = {};
      saveSessionToStorage();
      if (msgsEl) msgsEl.innerHTML = '';
      var welcome = config && config.widget_config && config.widget_config.welcome_message;
      if (welcome) appendMessage("assistant", welcome, "welcome");
      startPolling();
    }).catch(function (err) {
      if (msgsEl) {
        msgsEl.innerHTML = '<div style="text-align:center;color:#ef4444;padding:20px;font-size:13px;">Connection failed. Please try again.</div>';
      }
      console.error("[NexusAI] Session error:", err);
    });
  }

  function showResolvedBanner(messages) {
    messages = messages || [];
    var container = document.getElementById('nexus-messages');
    if (!container) return;
    stopPolling();
    container.innerHTML = '';
    seenIds = {};
    lastMessageId = null;
    messages.forEach(function (m) {
      appendMessageObj(m);
      lastMessageId = m.id;
    });

    var primary = (config && config.widget_config && config.widget_config.primary_color) || "#6B5CE7";
    var banner = document.createElement('div');
    banner.id = 'nexus-resolved-banner';
    banner.style.cssText = 'text-align:center;padding:16px;margin:12px 0;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;font-size:13px;color:#166534;';
    banner.innerHTML =
      '<div>✅ This conversation has been resolved.</div>' +
      '<button id="nexus-new-chat" type="button" style="margin-top:10px;background:' + primary + ';color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;">Start new conversation</button>';
    container.appendChild(banner);
    container.scrollTop = container.scrollHeight;

    var input = document.getElementById('nexus-input');
    var sendBtnEl = document.getElementById('nexus-send');
    if (input) {
      input.disabled = true;
      input.placeholder = 'Conversation resolved.';
    }
    if (sendBtnEl) sendBtnEl.disabled = true;

    var newChatBtn = document.getElementById('nexus-new-chat');
    if (newChatBtn) {
      newChatBtn.addEventListener('click', function () {
        clearSessionFromStorage();
        state.sessionToken = null;
        state.sessionId = null;
        state.conversationId = null;
        state.fallbackShownForConversation = false;
        state.thinkingStartTime = null;
        lastMessageId = null;
        seenIds = {};
        stopPolling();

        var inp = document.getElementById('nexus-input');
        var snd = document.getElementById('nexus-send');
        var placeholder = (config && config.widget_config && config.widget_config.placeholder_text) || 'Type a message…';
        if (inp) {
          inp.disabled = false;
          inp.placeholder = placeholder;
        }
        if (snd) snd.disabled = false;

        startFreshSession();
      });
    }
  }



  function resumeSession(stored) {
    if (msgsEl) {
      msgsEl.innerHTML = '<div style="text-align:center;color:#9ca3af;padding:20px;font-size:13px;">Resuming conversation…</div>';
    }
    var qs = "?conversation_id=" + encodeURIComponent(stored.conversationId) +
             "&session_token=" + encodeURIComponent(stored.sessionToken);
    return api("/widget-poll-messages" + qs, { method: "GET" }).then(function (res) {
      if (!res.ok || !res.body || !res.body.success) throw new Error("Session invalid");
      state.sessionToken = stored.sessionToken;
      state.sessionId = stored.sessionId;
      state.conversationId = stored.conversationId;
      lastMessageId = null;
      seenIds = {};
      if (msgsEl) msgsEl.innerHTML = '';

      var d = res.body.data;
      var messages = d.messages || [];

      if (d.conversation_status === 'resolved') {
        showResolvedBanner(messages);
        return;
      }

      if (messages.length === 0) {
        var welcome = config && config.widget_config && config.widget_config.welcome_message;
        if (welcome) appendMessage("assistant", welcome, "welcome");
      } else {
        messages.forEach(function (m) {
          appendMessageObj(m);
          lastMessageId = m.id;
        });
      }
      startPolling();
    });
  }

  function openPanel() {
    if (panel) {
      panel.style.display = "flex";
      if (state.sessionToken && state.conversationId) {
        startPolling();
        return;
      }
    }

    api("/get-public-widget-config?channel_id=" + encodeURIComponent(CHANNEL_ID), { method: "GET" })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.success) {
          alert("Chat unavailable.");
          return;
        }
        config = res.body.data;
        applyColor((config.widget_config && config.widget_config.primary_color) || "#111827");
        if (!panel) buildPanel();

        // Already have an in-memory session (e.g., panel was just closed)
        if (state.sessionToken && state.conversationId) {
          startPolling();
          return;
        }

        var stored = loadSessionFromStorage();
        if (stored.sessionToken && stored.conversationId && stored.channelId === CHANNEL_ID) {
          return resumeSession(stored).catch(function () {
            clearSessionFromStorage();
            return startFreshSession();
          });
        }
        return startFreshSession();
      })
      .catch(function () { alert("Chat unavailable."); });
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
    appendMessage("visitor", text);

    api("/receive-widget-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: state.conversationId, session_token: state.sessionToken, content: text }),
    }).then(function (res) {
      if (!res.ok || !res.body || !res.body.success) {
        appendMessage("system", (res.body && res.body.error) || "Failed to send.");
      }
    }).catch(function () {
      appendMessage("system", "Network error.");
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

  // Fetch config early just to color the bubble
  fetch(apiBase + "/get-public-widget-config?channel_id=" + encodeURIComponent(CHANNEL_ID))
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.success && j.data && j.data.widget_config && j.data.widget_config.primary_color) {
        applyColor(j.data.widget_config.primary_color);
      }
    }).catch(function () {});
})();
