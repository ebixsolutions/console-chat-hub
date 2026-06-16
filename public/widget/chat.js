/* NexusAI embeddable chat widget — vanilla JS, zero deps */
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

  var config = null;
  var lastMessageId = null;
  var seenIds = {};
  var state = {
    sessionToken: null,
    conversationId: null,
    pollInterval: null,
    thinkingStartTime: null,
    fallbackShownForConversation: false,
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
      '<div class="nx-msgs"></div>' +
      '<div class="nx-input">' +
        '<textarea placeholder="' + escapeHtml(placeholder) + '" rows="1"></textarea>' +
        '<button class="nx-send" type="button" style="background:' + primary + '">Send</button>' +
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

  function showTyping(show) {
    if (show) {
      if (!typingEl) {
        typingEl = document.createElement("div");
        typingEl.className = "nx-typing";
        typingEl.innerHTML = "<span></span><span></span><span></span>";
      }
      if (typingEl.parentNode !== msgsEl) {
        msgsEl.appendChild(typingEl);
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }
    } else if (typingEl && typingEl.parentNode === msgsEl) {
      msgsEl.removeChild(typingEl);
    }
  }

  function api(path, opts) {
    return fetch(apiBase + path, opts).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; });
    });
  }

  function startPolling() {
    if (pollInterval) return;
    pollInterval = setInterval(poll, 2500);
  }
  function stopPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  }

  function poll() {
    if (!conversationId || !sessionToken) return;
    var qs = "?conversation_id=" + encodeURIComponent(conversationId) +
             "&session_token=" + encodeURIComponent(sessionToken) +
             (lastMessageId ? "&after_message_id=" + encodeURIComponent(lastMessageId) : "");
    api("/widget-poll-messages" + qs, { method: "GET" }).then(function (res) {
      if (!res.ok || !res.body || !res.body.success) return;
      var d = res.body.data;
      (d.messages || []).forEach(function (m) {
        appendMessage(m.role, m.content, m.id);
        lastMessageId = m.id;
      });

      if (d.ai_generating) {
        if (!thinkingSince) thinkingSince = Date.now();
        if (!fallbackShownForConversation) {
          if (Date.now() - thinkingSince >= 60000) {
            showTyping(false);
            fallbackShownForConversation = true;
            appendMessage("assistant", "Your message was received. AI reply not available in this phase.");
          } else {
            showTyping(true);
          }
        } else {
          showTyping(false);
        }
      } else {
        thinkingSince = null;
        showTyping(false);
      }
    }).catch(function () {});
  }

  function openPanel() {
    if (panel) { panel.style.display = "flex"; startPolling(); return; }

    api("/get-public-widget-config?channel_id=" + encodeURIComponent(channelId), { method: "GET" })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.success) {
          alert("Chat unavailable.");
          return;
        }
        config = res.body.data;
        applyColor((config.widget_config && config.widget_config.primary_color) || "#111827");
        buildPanel();

        return api("/create-visitor-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel_id: channelId }),
        }).then(function (s) {
          if (!s.ok || !s.body || !s.body.success) {
            appendMessage("system", "Unable to start chat session.");
            return;
          }
          sessionToken = s.body.data.session_token;
          conversationId = s.body.data.conversation_id;

          var welcome = config.widget_config && config.widget_config.welcome_message;
          if (welcome) appendMessage("assistant", welcome);

          startPolling();
        });
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
    if (!text || !conversationId || !sessionToken) return;
    if (text.length > 2000) { alert("Message too long (max 2000)."); return; }

    sendBtn.disabled = true;
    inputEl.value = "";
    appendMessage("visitor", text);
    fallbackShownForConversation = false;

    api("/receive-widget-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId, session_token: sessionToken, content: text }),
    }).then(function (res) {
      sendBtn.disabled = false;
      if (!res.ok || !res.body || !res.body.success) {
        appendMessage("system", (res.body && res.body.error) || "Failed to send.");
        return;
      }
      thinkingSince = Date.now();
      showTyping(true);
      if (!pollInterval) startPolling();
    }).catch(function () {
      sendBtn.disabled = false;
      appendMessage("system", "Network error.");
    });
  }

  bubble.addEventListener("click", function () {
    if (panel && panel.style.display !== "none") closePanel();
    else openPanel();
  });

  // Fetch config early just to color the bubble
  fetch(apiBase + "/get-public-widget-config?channel_id=" + encodeURIComponent(channelId))
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.success && j.data && j.data.widget_config && j.data.widget_config.primary_color) {
        applyColor(j.data.widget_config.primary_color);
      }
    }).catch(function () {});
})();
