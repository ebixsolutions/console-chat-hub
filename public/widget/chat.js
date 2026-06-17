(function () {
  if (window.__nexusChatLoaded) return;
  window.__nexusChatLoaded = true;

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName("script");
    return s[s.length - 1];
  })();
  var channelId = script.getAttribute("data-channel-id");
  var apiBase = (script.getAttribute("data-api-base") || "").replace(/\/$/, "");
  if (!channelId || !apiBase) { console.error("[NexusAI] data-channel-id and data-api-base are required"); return; }

  // --- Storage ---
  var P = "nexus_widget_" + channelId;
  var SK_TOKEN = P + "_session_token", SK_CONV = P + "_conversation_id",
      SK_CHANNEL = P + "_channel_id", SK_TICKETS = P + "_tickets";

  function saveSession() { try { localStorage.setItem(SK_TOKEN,state.sessionToken); localStorage.setItem(SK_CONV,state.conversationId); localStorage.setItem(SK_CHANNEL,channelId); } catch(e){} }
  function clearSession() { try { localStorage.removeItem(SK_TOKEN); localStorage.removeItem(SK_CONV); localStorage.removeItem(SK_CHANNEL); } catch(e){} }
  function loadSession() { try { return { token:localStorage.getItem(SK_TOKEN), convId:localStorage.getItem(SK_CONV), channel:localStorage.getItem(SK_CHANNEL) }; } catch(e){ return {}; } }
  function saveTicket(cid,tok){ try { var t=JSON.parse(localStorage.getItem(SK_TICKETS)||"[]"); if(!t.some(function(x){return x.conversation_id===cid;})){ t.unshift({ticket_no:cid.substring(0,7),conversation_id:cid,session_token:tok,status:"open",last_message:"",created_at:new Date().toISOString(),updated_at:new Date().toISOString()}); localStorage.setItem(SK_TICKETS,JSON.stringify(t.slice(0,20)));}} catch(e){} }
  function updateTicket(cid,status,msg){ try { var t=JSON.parse(localStorage.getItem(SK_TICKETS)||"[]"),i=t.findIndex(function(x){return x.conversation_id===cid;}); if(i>=0){if(status)t[i].status=status; if(msg)t[i].last_message=msg; t[i].updated_at=new Date().toISOString(); localStorage.setItem(SK_TICKETS,JSON.stringify(t));}} catch(e){} }
  function getTickets(){ try{return JSON.parse(localStorage.getItem(SK_TICKETS)||"[]");}catch(e){return [];} }

  // --- Online check ---
  function isOnline(){ var cfg=config&&config.widget_config; if(!cfg||!cfg.business_hours||!cfg.business_hours.schedule) return true; try{ var tz=cfg.business_hours.timezone||"UTC",now=new Date(),ls=now.toLocaleString("en-US",{timeZone:tz,hour12:false,weekday:"short",hour:"2-digit",minute:"2-digit"}),p=ls.split(", "),dm={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6},d=dm[p[0]]!==undefined?dm[p[0]]:now.getDay(),tp=p[1].split(":"),cm=parseInt(tp[0])*60+parseInt(tp[1]); for(var i=0;i<cfg.business_hours.schedule.length;i++){var s=cfg.business_hours.schedule[i]; if(s.days&&s.days.indexOf(d)!==-1){var o=s.open.split(":").reduce(function(h,m){return parseInt(h)*60+parseInt(m);}),c=s.close.split(":").reduce(function(h,m){return parseInt(h)*60+parseInt(m);}); if(cm>=o&&cm<c)return true;}} return false;} catch(e){return true;} }

  // --- State ---
  var config=null,lastMessageId=null,seenIds={};
  var state={sessionToken:null,conversationId:null,pollInterval:null,thinkingStartTime:null,fallbackShownForConversation:false,handoffRequested:false,firstMessageSent:false,messages:[],online:true};

  // --- Styles ---
  var style=document.createElement("style");
  style.textContent=[
    ".nx-root *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".nx-bubble{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:9999px;border:none;color:#fff;font-size:26px;cursor:pointer;box-shadow:0 10px 25px rgba(0,0,0,.25);z-index:2147483646;display:flex;align-items:center;justify-content:center;transition:transform .15s ease;background:#6B5CE7}",
    ".nx-bubble:hover{transform:scale(1.06)}",
    ".nx-panel{position:fixed;right:20px;bottom:88px;width:360px;height:560px;min-width:300px;min-height:400px;max-width:80vw;max-height:90vh;background:#fff;border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.25);z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom right;animation:nxIn .18s ease-out}",
    "@keyframes nxIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}",
    ".nx-header{padding:10px 14px;color:#fff;display:flex;align-items:center;justify-content:space-between;font-weight:600;min-height:52px;cursor:grab;user-select:none}",
    ".nx-header.dragging{cursor:grabbing}",
    ".nx-header-left{display:flex;flex-direction:column;gap:2px;pointer-events:none}",
    ".nx-header-title{font-size:15px;font-weight:700}",
    ".nx-header-sub{font-size:11px;font-weight:400;opacity:.85;display:flex;align-items:center;gap:5px}",
    ".nx-online-dot{width:7px;height:7px;border-radius:9999px;display:inline-block;flex-shrink:0}",
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
    ".nx-input-area{border-top:1px solid #e5e7eb;background:#fff;position:relative}",
    ".nx-input-row{padding:8px 10px;display:flex;gap:6px;align-items:flex-end}",
    ".nx-plus-wrap{position:relative}",
    ".nx-plus-btn{background:none;border:1px solid #e5e7eb;border-radius:8px;color:#6b7280;cursor:pointer;font-size:18px;font-weight:300;width:32px;height:36px;display:flex;align-items:center;justify-content:center;transition:all .15s}",
    ".nx-plus-btn:hover{background:#f3f4f6;color:#374151;border-color:#9ca3af}",
    ".nx-plus-menu{position:absolute;bottom:44px;left:0;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);min-width:180px;overflow:hidden;z-index:100}",
    ".nx-plus-item{padding:10px 14px;font-size:13px;color:#374151;cursor:pointer;display:flex;align-items:center;gap:8px;white-space:nowrap}",
    ".nx-plus-item:hover{background:#f5f3ff;color:#5b21b6}",
    ".nx-plus-item:disabled,.nx-plus-item.disabled{opacity:.5;cursor:not-allowed;pointer-events:none}",
    ".nx-emoji-btn{background:none;border:none;color:#9ca3af;cursor:pointer;font-size:18px;padding:4px;height:36px;width:30px;display:flex;align-items:center;justify-content:center;border-radius:6px}",
    ".nx-emoji-btn:hover{background:#f3f4f6}",
    ".nx-emoji-panel{position:absolute;bottom:52px;left:42px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:8px;display:grid;grid-template-columns:repeat(8,28px);gap:2px;z-index:100}",
    ".nx-emoji-item{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;border-radius:6px;border:none;background:none}",
    ".nx-emoji-item:hover{background:#f3f4f6}",
    ".nx-input-row textarea{flex:1;resize:none;border:1px solid #e5e7eb;border-radius:8px;padding:7px 10px;font-size:14px;outline:none;height:36px;max-height:120px;font-family:inherit;overflow-y:auto}",
    ".nx-input-row textarea:focus{border-color:#9ca3af}",
    ".nx-send{border:none;color:#fff;padding:0 14px;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px;height:36px;min-width:56px}",
    ".nx-send:disabled{opacity:.5;cursor:not-allowed}",
    ".nx-footer{text-align:center;padding:5px;font-size:11px;color:#d1d5db;background:#fff;border-top:1px solid #f3f4f6}",
    ".nx-resolved{margin:12px;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;text-align:center;font-size:13px;color:#166534}",
    ".nx-new-chat{margin-top:10px;background:#6B5CE7;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;font-family:inherit}",
    ".nx-file-preview{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#f3f4f6;border-top:1px solid #e5e7eb;font-size:12px;color:#374151}",
    ".nx-file-preview-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".nx-file-remove{background:none;border:none;color:#9ca3af;cursor:pointer;font-size:14px;padding:0 4px}",
    ".nx-resize-handle{position:absolute;bottom:0;left:0;width:16px;height:16px;cursor:nw-resize;z-index:10;opacity:0}",
    ".nx-tickets-page{position:absolute;top:0;left:0;right:0;bottom:0;background:#fff;display:flex;flex-direction:column;z-index:10;border-radius:14px;overflow:hidden}",
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
    "@media(max-width:480px){.nx-panel{right:0!important;left:0!important;bottom:0!important;top:auto!important;width:100%!important;height:85vh!important;border-radius:16px 16px 0 0;max-width:100%;resize:none!important} .nx-bubble{right:16px;bottom:16px} .nx-resize-handle{display:none!important}}",
  ].join("");
  document.head.appendChild(style);

  // --- DOM ---
  var root=document.createElement("div"); root.className="nx-root"; document.body.appendChild(root);
  var bubble=document.createElement("button"); bubble.className="nx-bubble"; bubble.type="button"; bubble.setAttribute("aria-label","Open chat"); bubble.innerHTML="💬"; root.appendChild(bubble);
  var panel=null,msgsEl,inputEl,sendBtn,tagsEl,typingEl,filePreviewEl,pendingFile=null;
  var emojiPanelEl=null,plusMenuEl=null;

  function getPrimary(){ return (config&&config.widget_config&&config.widget_config.primary_color)||"#6B5CE7"; }
  function applyColor(c){ bubble.style.background=c; }
  function esc(s){ return String(s).replace(/[&<>"']/g,function(c){return{"&":"&","<":"<",">":">","'":"'"}[c];}); }
  function getTicketNo(){ return state.conversationId?state.conversationId.substring(0,7):"-------"; }
  function getSuggested(){ var d=["Track my order","Shipping fee and delivery?","Cancel order & refund","What's the return policy?","Contact human support"]; if(!config||!config.widget_config) return d; var sq=config.widget_config.suggested_questions; return (Array.isArray(sq)&&sq.length>0)?sq:d; }

  // --- Build Panel ---
  function buildPanel(){
    var primary=getPrimary();
    var title=(config&&config.widget_config&&config.widget_config.header_title)||"Customer Support";
    var ph=(config&&config.widget_config&&config.widget_config.placeholder_text)||"Type a message\u2026";
    var online=state.online;

    panel=document.createElement("div"); panel.className="nx-panel";
    panel.innerHTML=
      '<div id="nx-header" class="nx-header" style="background:'+primary+'">\n' +
        '<div class="nx-header-left">\n' +
          '<span class="nx-header-title">'+esc(title)+'</span>\n' +
          '<span class="nx-header-sub">\n' +
            '<span class="nx-online-dot" style="background:'+(online?"#22c55e":"#9ca3af")+'"></span>'+(online?"Online":"Offline")+'  \u00b7  Chat #'+getTicketNo()+'\n' +
          '</span>\n' +
        '</div>\n' +
        '<div class="nx-header-actions">\n' +
          '<button id="nx-my-tickets-btn" class="nx-header-btn" title="My Tickets">\u2637</button>\n' +
          '<button id="nx-close-btn" class="nx-header-btn" title="Close">\u00d7</button>\n' +
        '</div>\n' +
      '</div>\n' +
      '<div id="nx-tags-area" class="nx-tags" style="display:none"></div>\n' +
      '<div id="nx-msgs" class="nx-msgs"></div>\n' +
      '<div id="nx-file-preview" class="nx-file-preview" style="display:none">\n' +
        '<span class="nx-file-preview-icon" id="nx-file-icon"></span>\n' +
        '<span class="nx-file-preview-name" id="nx-file-name"></span>\n' +
        '<button id="nx-file-remove-btn" class="nx-file-remove">\u00d7</button>\n' +
      '</div>\n' +
      '<div id="nx-input-area" class="nx-input-area">\n' +
        '<div class="nx-input-row">\n' +
          '<div class="nx-plus-wrap">\n' +
            '<button id="nx-plus-btn" class="nx-plus-btn" title="More">\n+\n</button>\n' +
          '</div>\n' +
          '<button id="nx-emoji-btn" class="nx-emoji-btn" title="Emoji">\u263a</button>\n' +
          '<textarea id="nx-input" placeholder="'+esc(ph)+'" rows="1"></textarea>\n' +
          '<button id="nx-send" class="nx-send" style="background:'+primary+'">Send</button>\n' +
        '</div>\n' +
      '</div>\n' +
      '<div class="nx-footer">Powered by NexusAI</div>';
    root.appendChild(panel);

    msgsEl=panel.querySelector("#nx-msgs");
    inputEl=panel.querySelector("#nx-input");
    sendBtn=panel.querySelector("#nx-send");
    tagsEl=panel.querySelector("#nx-tags-area");
    filePreviewEl=panel.querySelector("#nx-file-preview");

    // Hidden file inputs
    var imgInput=document.createElement("input"); imgInput.type="file"; imgInput.accept="image/*"; imgInput.style.display="none"; imgInput.id="nx-img-input"; document.body.appendChild(imgInput);
    var vidInput=document.createElement("input"); vidInput.type="file"; vidInput.accept="video/*"; vidInput.style.display="none"; vidInput.id="nx-vid-input"; document.body.appendChild(vidInput);
    imgInput.addEventListener("change",function(){ handleFileSelect(imgInput,"image"); });
    vidInput.addEventListener("change",function(){ handleFileSelect(vidInput,"video"); });

    panel.querySelector("#nx-close-btn").addEventListener("click",closePanel);
    panel.querySelector("#nx-my-tickets-btn").addEventListener("click",showMyTickets);
    sendBtn.addEventListener("click",handleSend);
    inputEl.addEventListener("keydown",function(e){ if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();handleSend();} });
    inputEl.addEventListener("input",function(){ inputEl.style.height="36px"; inputEl.style.height=Math.min(inputEl.scrollHeight,120)+"px"; });

    // Plus menu
    var plusBtn=panel.querySelector("#nx-plus-btn");
    plusBtn.addEventListener("click",function(e){ e.stopPropagation(); togglePlusMenu(); });

    // Emoji button
    var emojiBtn=panel.querySelector("#nx-emoji-btn");
    emojiBtn.addEventListener("click",function(e){ e.stopPropagation(); toggleEmojiPanel(); });

    // Close menus on outside click
    document.addEventListener("click",function(){ closePlusMenu(); closeEmojiPanel(); });

    // Drag + Resize
    initDrag();
    initResize();

    showSuggestedQuestions();
  }

  // --- Plus Menu ---
  function togglePlusMenu(){
    if(plusMenuEl){ closePlusMenu(); return; }
    closeEmojiPanel();
    var inputArea=panel.querySelector("#nx-input-area");
    plusMenuEl=document.createElement("div"); plusMenuEl.className="nx-plus-menu";
    plusMenuEl.innerHTML=
      '<div id="nx-menu-img" class="nx-plus-item">\n  <span>\ud83d\udcf7</span> Upload Image\n</div>\n' +
      '<div id="nx-menu-vid" class="nx-plus-item">\n  <span>\ud83c\udfac</span> Upload Video\n</div>\n' +
      '<div id="nx-menu-human" class="nx-plus-item" '+(state.handoffRequested?'disabled style="opacity:.5;cursor:not-allowed"':'')+'>\n  <span>\ud83d\udc64</span> Request Human Support\n</div>';
    inputArea.querySelector(".nx-plus-wrap").appendChild(plusMenuEl);
    plusMenuEl.querySelector("#nx-menu-img").addEventListener("click",function(e){ e.stopPropagation(); closePlusMenu(); document.getElementById("nx-img-input").click(); });
    plusMenuEl.querySelector("#nx-menu-vid").addEventListener("click",function(e){ e.stopPropagation(); closePlusMenu(); document.getElementById("nx-vid-input").click(); });
    var humanItem=plusMenuEl.querySelector("#nx-menu-human");
    if(!state.handoffRequested){
      humanItem.addEventListener("click",function(e){ e.stopPropagation(); closePlusMenu(); handleHumanSupport(); });
    }
  }
  function closePlusMenu(){ if(plusMenuEl&&plusMenuEl.parentNode){ plusMenuEl.parentNode.removeChild(plusMenuEl); } plusMenuEl=null; }

  // --- Emoji Panel ---
  var EMOJIS=["😊","😂","🙏","👍","❤️","🎉","😅","😭","🔥","✅","👋","😍","🤔","😢","😎","🙌","💪","😁","🥰","🤩","😴","😡","👀","💯"];
  function toggleEmojiPanel(){
    if(emojiPanelEl){ closeEmojiPanel(); return; }
    closePlusMenu();
    var inputArea=panel.querySelector("#nx-input-area");
    emojiPanelEl=document.createElement("div"); emojiPanelEl.className="nx-emoji-panel";
    EMOJIS.forEach(function(em){
      var btn=document.createElement("button"); btn.className="nx-emoji-item"; btn.textContent=em; btn.type="button";
      btn.addEventListener("click",function(e){ e.stopPropagation(); insertEmoji(em); });
      emojiPanelEl.appendChild(btn);
    });
    inputArea.appendChild(emojiPanelEl);
  }
  function closeEmojiPanel(){ if(emojiPanelEl&&emojiPanelEl.parentNode){ emojiPanelEl.parentNode.removeChild(emojiPanelEl); } emojiPanelEl=null; }
  function insertEmoji(em){
    if(!inputEl) return;
    var s=inputEl.selectionStart||inputEl.value.length, e=inputEl.selectionEnd||inputEl.value.length;
    inputEl.value=inputEl.value.substring(0,s)+em+inputEl.value.substring(e);
    inputEl.selectionStart=inputEl.selectionEnd=s+em.length;
    inputEl.focus();
  }

  // --- File Select Simulation ---
  // Fix 3: Upload is SIMULATED ONLY — no file is uploaded to server in Widget MVP
  function handleFileSelect(inp,type){
    if(!inp.files||!inp.files[0]) return;
    var file=inp.files[0];
    console.log("[NexusAI] File selected (simulated, not uploaded):", file.name, type);
    pendingFile={name:file.name,type:type,size:file.size};
    var icon=type==="image"?"📷":"🎬";
    if(filePreviewEl){
      filePreviewEl.style.display="flex";
      filePreviewEl.querySelector("#nx-file-icon").textContent=icon;
      filePreviewEl.querySelector("#nx-file-name").textContent=file.name;
      filePreviewEl.querySelector("#nx-file-remove-btn").addEventListener("click",clearPendingFile);
    }
    inp.value="";
  }
  function clearPendingFile(){ pendingFile=null; if(filePreviewEl) filePreviewEl.style.display="none"; }

  // --- Drag (Desktop only) ---
  function initDrag(){
    var hdr=panel.querySelector("#nx-header");
    if(!hdr) return;
    var dragging=false,ox=0,oy=0;
    function isMobile(){ return window.innerWidth<=480; }
    hdr.addEventListener("mousedown",function(e){
      if(isMobile()) return;
      if(e.target.closest("button")||e.target.closest(".nx-header-actions")) return;
      dragging=true;
      var r=panel.getBoundingClientRect();
      ox=e.clientX-r.left; oy=e.clientY-r.top;
      panel.style.right="auto"; panel.style.bottom="auto";
      panel.style.left=r.left+"px"; panel.style.top=r.top+"px";
      hdr.classList.add("dragging");
      e.preventDefault();
    });
    document.addEventListener("mousemove",function(e){
      if(!dragging) return;
      var nl=e.clientX-ox, nt=e.clientY-oy;
      var r=panel.getBoundingClientRect();
      nl=Math.max(0,Math.min(nl,window.innerWidth-r.width));
      nt=Math.max(0,Math.min(nt,window.innerHeight-r.height));
      panel.style.left=nl+"px"; panel.style.top=nt+"px";
    });
    document.addEventListener("mouseup",function(){
      dragging=false;
      if(hdr) hdr.classList.remove("dragging");
    });
  }

  // --- Resize (Desktop only, bottom-left corner handle) ---
  function initResize(){
    var handle=document.createElement("div"); handle.className="nx-resize-handle";
    panel.style.position="fixed"; // ensure
    panel.appendChild(handle);
    var resizing=false,startX=0,startY=0,startW=0,startH=0,startRight=0;
    function isMobile(){ return window.innerWidth<=480; }
    handle.style.cssText="position:absolute;bottom:0;left:0;width:20px;height:20px;cursor:sw-resize;z-index:10;";
    // Visual grip dots
    handle.innerHTML='<svg width="20" height="20" viewBox="0 0 20 20" style="opacity:.6"><circle cx="5" cy="15" r="1.5" fill="rgba(0,0,0,0.45)"/><circle cx="10" cy="15" r="1.5" fill="rgba(0,0,0,0.45)"/><circle cx="15" cy="15" r="1.5" fill="rgba(0,0,0,0.45)"/><circle cx="10" cy="10" r="1.5" fill="rgba(0,0,0,0.45)"/><circle cx="15" cy="10" r="1.5" fill="rgba(0,0,0,0.45)"/><circle cx="15" cy="5" r="1.5" fill="rgba(0,0,0,0.45)"/></svg>';
    handle.style.opacity="1";

    handle.addEventListener("mousedown",function(e){
      if(isMobile()) return;
      resizing=true;
      // Fix 1: Convert from right/bottom to left/top before resizing to avoid jump
      var r=panel.getBoundingClientRect();
      panel.style.right="auto"; panel.style.bottom="auto";
      panel.style.left=r.left+"px"; panel.style.top=r.top+"px";
      startX=e.clientX; startY=e.clientY;
      startW=r.width; startH=r.height;
      startRight=r.right; // Fix: store right anchor so left edge can move correctly
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener("mousemove",function(e){
      if(!resizing) return;
      var dw=startX-e.clientX, dh=e.clientY-startY;
      var nw=Math.max(300,Math.min(startW+dw,800));
      var nh=Math.max(400,Math.min(startH+dh,window.innerHeight*0.9));
      panel.style.width=nw+"px"; panel.style.height=nh+"px";
      // Fix: use startRight (fixed right anchor) so left edge moves as user drags left
      var newLeft=startRight-nw;
      if(newLeft<0) newLeft=0; // clamp to viewport left edge
      panel.style.left=newLeft+"px";
    });
    document.addEventListener("mouseup",function(){ resizing=false; });
  }

  // --- Human Support ---
  function handleHumanSupport(){
    if(!state.sessionToken||!state.conversationId||state.handoffRequested) return;
    state.handoffRequested=true;
    api("/receive-widget-message",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({conversation_id:state.conversationId,session_token:state.sessionToken,content:"I\u2019d like to speak with a human agent."})}).catch(function(){});
    appendMessageObj({id:"system-handoff-"+Date.now(),role:"system",content:"We\u2019re connecting you to a team member.\nEstimated wait time: 2\u20135 minutes.",created_at:new Date().toISOString()});
  }

  // --- Suggested Questions ---
  function showSuggestedQuestions(){
    if(!tagsEl||state.firstMessageSent) return;
    var qs=getSuggested(); if(!qs.length) return;
    tagsEl.innerHTML="";
    qs.forEach(function(q){
      var b=document.createElement("button"); b.className="nx-tag"; b.textContent=q;
      b.addEventListener("click",function(){ if(inputEl)inputEl.value=q; hideTags(); handleSend(); });
      tagsEl.appendChild(b);
    });
    tagsEl.style.display="flex";
  }
  function hideTags(){ if(tagsEl)tagsEl.style.display="none"; state.firstMessageSent=true; }

  // --- My Tickets ---
  function showMyTickets(){
    if(!panel) return;
    var primary=getPrimary();
    var page=document.createElement("div"); page.className="nx-tickets-page";
    var tickets=getTickets();
    var listHtml=tickets.length===0?'<div class="nx-tickets-empty">\n  <div style="font-size:32px;margin-bottom:8px">\ud83d\udccb</div>\n  <div>No previous tickets</div>\n</div>':tickets.map(function(t){
      var sl=t.status==="resolved"?"Resolved":t.status==="human_needed"?"Waiting":"Open";
      return '<div class="nx-ticket-item" data-conv="'+esc(t.conversation_id)+'" data-token="'+esc(t.session_token)+'">\n<div class="nx-ticket-row">\n  <span class="nx-ticket-no">Chat #'+esc(t.ticket_no)+'</span>\n  <span class="nx-ticket-status '+t.status+'">'+sl+'</span>\n</div>\n<div class="nx-ticket-preview">'+esc(t.last_message||"(no messages yet)")+'</div>\n<div class="nx-ticket-time">'+new Date(t.updated_at).toLocaleDateString()+'</div>\n</div>';
    }).join("");
    page.innerHTML='<div class="nx-tickets-header" style="background:'+primary+'">\n  <button id="nx-tix-back" class="nx-tickets-back">\u2190</button>\n  <span>My Tickets</span>\n</div>\n<div class="nx-tickets-list">'+listHtml+'</div>\n<button id="nx-tix-new" class="nx-tickets-new">+ Start New Conversation</button>';
    panel.appendChild(page);
    page.querySelector("#nx-tix-back").addEventListener("click",function(){ page.remove(); });
    page.querySelector("#nx-tix-new").addEventListener("click",function(){ page.remove(); resetAndFresh(); });
    page.querySelectorAll(".nx-ticket-item").forEach(function(item){ item.addEventListener("click",function(){ page.remove(); tryRestoreSession({convId:item.getAttribute("data-conv"),token:item.getAttribute("data-token")}); }); });
  }

  // --- Messages ---
  function isLocalId(id){ var s=String(id||""); return s.indexOf("system-")===0||s.indexOf("fallback-")===0||s==="welcome"; }
  function renderMsg(m){
    if(m.is_recalled){ var el=document.createElement("div"); el.className="nx-recalled"; el.textContent="[\u8a0a\u606f\u5df2\u64a4\u56de]"; return el; }
    var el=document.createElement("div"); el.className="nx-msg "+(m.role||"assistant");
    if(m.role==="visitor") el.style.background=getPrimary();
    el.textContent=m.content; return el;
  }
  function appendMessageObj(m){
    if(!msgsEl||m.content==="__THINKING__"||seenIds[m.id]) return;
    seenIds[m.id]=true;
    var idx=state.messages.findIndex(function(x){return x.id===m.id;}); if(idx>=0) state.messages[idx]=m; else state.messages.push(m);
    var el=renderMsg(m);
    if(typingEl&&typingEl.parentNode===msgsEl) msgsEl.insertBefore(el,typingEl); else msgsEl.appendChild(el);
    if(!isLocalId(m.id)){ lastMessageId=m.id; if(m.role!=="system") updateTicket(state.conversationId,null,m.content.substring(0,80)); }
    msgsEl.scrollTop=msgsEl.scrollHeight;
  }
  function appendWelcome(){
    var w=config&&config.widget_config&&config.widget_config.welcome_message;
    if(!w&&!state.online){
      // Fix 2: use config.offline_message if set, else fallback
      w=(config&&config.widget_config&&config.widget_config.offline_message)||"Our team is currently offline. Please leave a message.";
    }
    if(w) appendMessageObj({id:"welcome",role:"assistant",content:w});
  }
  function updateHeader(){ var no=panel&&panel.querySelector("#nx-ticket-no"); if(no) no.textContent=getTicketNo(); }
  function showTyping(){ if(!typingEl){typingEl=document.createElement("div");typingEl.className="nx-typing";typingEl.id="nexus-typing-indicator";typingEl.innerHTML="<span></span><span></span><span></span>";} if(msgsEl&&typingEl.parentNode!==msgsEl){msgsEl.appendChild(typingEl);msgsEl.scrollTop=msgsEl.scrollHeight;} }
  function hideTyping(){ if(typingEl&&typingEl.parentNode) typingEl.parentNode.removeChild(typingEl); }

  function showResolvedBanner(messages){
    if(!msgsEl) return;
    msgsEl.innerHTML=""; seenIds={}; state.messages=[]; lastMessageId=null; state.firstMessageSent=true; hideTags();
    (messages||[]).forEach(function(m){appendMessageObj(m);});
    var b=document.createElement("div"); b.className="nx-resolved";
    b.innerHTML="\u2705 This conversation has been resolved.\n<br>\n<button class=\"nx-new-chat\">Start new conversation</button>";
    msgsEl.appendChild(b); msgsEl.scrollTop=msgsEl.scrollHeight;
    if(inputEl){inputEl.disabled=true;inputEl.placeholder="Conversation resolved.";}
    if(sendBtn)sendBtn.disabled=true;
    updateTicket(state.conversationId,"resolved",null);
    b.querySelector(".nx-new-chat").addEventListener("click",function(){ resetAndFresh(); });
  }

  function resetAndFresh(){
    clearSession(); state.sessionToken=null; state.conversationId=null; state.messages=[]; state.handoffRequested=false; state.firstMessageSent=false; state.fallbackShownForConversation=false; state.thinkingStartTime=null; seenIds={}; lastMessageId=null; stopPolling(); clearPendingFile();
    if(inputEl){inputEl.disabled=false;inputEl.placeholder=(config&&config.widget_config&&config.widget_config.placeholder_text)||"Type a message\u2026";}
    if(sendBtn)sendBtn.disabled=false;
    startFreshSession();
  }

  // --- API ---
  function api(path,opts){ return fetch(apiBase+path,opts).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,body:j};});}); }

  // --- Poll ---
  function startPolling(){ if(state.pollInterval)return; state.pollInterval=setInterval(poll,2500); }
  function stopPolling(){ if(state.pollInterval){clearInterval(state.pollInterval);state.pollInterval=null;} }
  function poll(){
    if(!state.conversationId||!state.sessionToken) return;
    var qs="?conversation_id="+encodeURIComponent(state.conversationId)+"&session_token="+encodeURIComponent(state.sessionToken)+(lastMessageId?"&after_message_id="+encodeURIComponent(lastMessageId):"");
    api("/widget-poll-messages"+qs,{method:"GET"}).then(function(res){
      if(!res.ok||!res.body||!res.body.success) return;
      var d=res.body.data;
      if(d.conversation_status==="resolved"){ hideTyping(); stopPolling(); var nm=d.messages||[]; nm.forEach(function(m){if(!state.messages.some(function(x){return x.id===m.id;}))state.messages.push(m);}); var merged=state.messages.filter(function(m){return m.content!=="__THINKING__";}).filter(function(m,i,a){return a.findIndex(function(x){return x.id===m.id;})===i;}).sort(function(a,b){return new Date(a.created_at)-new Date(b.created_at);}); showResolvedBanner(merged); return; }
      (d.messages||[]).forEach(function(m){appendMessageObj(m);if(m.role==="visitor")hideTags();});
      var ag=d.ai_generating;
      if(ag&&state.handoffRequested){hideTyping();state.thinkingStartTime=null;state.fallbackShownForConversation=true;return;}
      if(ag){if(!state.fallbackShownForConversation){if(!state.thinkingStartTime)state.thinkingStartTime=Date.now(); if(!document.getElementById("nexus-typing-indicator"))showTyping(); if(Date.now()-state.thinkingStartTime>60000){hideTyping();state.thinkingStartTime=null;state.fallbackShownForConversation=true;appendMessageObj({id:"fallback-"+Date.now(),role:"system",content:"Your message was received. Our team will reply shortly.",created_at:new Date().toISOString()});}}}
      else{state.thinkingStartTime=null;state.fallbackShownForConversation=false;hideTyping();}
    }).catch(function(){});
  }

  // --- Session ---
  function startFreshSession(){
    if(msgsEl)msgsEl.innerHTML='<div style="text-align:center;padding:40px 20px;color:#9ca3af">\n  <div style="font-size:32px;margin-bottom:8px">\u231b</div>\n  <div>Connecting\u2026</div>\n</div>';
    state.messages=[];seenIds={};lastMessageId=null;
    api("/create-visitor-session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({channel_id:channelId})}).then(function(s){
      if(!s.ok||!s.body||!s.body.success){if(msgsEl)msgsEl.innerHTML='<div style="text-align:center;padding:40px 20px;color:#9ca3af">\n  <div style="font-size:32px;margin-bottom:8px">\u26a0</div>\n  <div>Unable to start session.</div>\n</div>';return;}
      state.sessionToken=s.body.data.session_token; state.conversationId=s.body.data.conversation_id;
      saveSession(); saveTicket(state.conversationId,state.sessionToken); updateHeader();
      if(msgsEl)msgsEl.innerHTML=""; state.online=isOnline(); appendWelcome(); showSuggestedQuestions(); startPolling();
    }).catch(function(){if(msgsEl)msgsEl.innerHTML='<div style="text-align:center;padding:40px 20px;color:#9ca3af">\n  <div style="font-size:32px;margin-bottom:8px">\u26a0</div>\n  <div>Connection failed.</div>\n</div>';});
  }

  function tryRestoreSession(stored){
    if(msgsEl)msgsEl.innerHTML='<div style="text-align:center;padding:40px 20px;color:#9ca3af">\n  <div style="font-size:32px;margin-bottom:8px">\u231b</div>\n  <div>Resuming\u2026</div>\n</div>';
    hideTags();
    api("/widget-poll-messages?conversation_id="+encodeURIComponent(stored.convId)+"&session_token="+encodeURIComponent(stored.token),{method:"GET"}).then(function(res){
      if(!res.ok||!res.body||!res.body.success) throw new Error("fail");
      var d=res.body.data;
      state.sessionToken=stored.token; state.conversationId=stored.convId;
      saveSession(); saveTicket(state.conversationId,state.sessionToken);
      state.messages=[];seenIds={};lastMessageId=null;
      if(msgsEl)msgsEl.innerHTML=""; updateHeader();
      if(d.conversation_status==="resolved"){showResolvedBanner(d.messages||[]);}
      else{var msgs=d.messages||[]; if(msgs.length===0){appendWelcome();showSuggestedQuestions();}else{msgs.forEach(function(m){appendMessageObj(m);});state.firstMessageSent=true;} startPolling();}
    }).catch(function(){clearSession();state.sessionToken=null;state.conversationId=null;startFreshSession();});
  }

  // --- Open/Close ---
  function openPanel(){
    if(panel&&panel.style.display!=="none") return;
    if(panel&&state.sessionToken){panel.style.display="flex";startPolling();return;}
    var cp=config?Promise.resolve():api("/get-public-widget-config?channel_id="+encodeURIComponent(channelId),{method:"GET"}).then(function(res){if(!res.ok||!res.body||!res.body.success)throw new Error("fail");config=res.body.data;state.online=isOnline();applyColor(getPrimary());});
    cp.then(function(){if(!panel)buildPanel();panel.style.display="flex";var s=loadSession();if(s.token&&s.convId&&s.channel===channelId)tryRestoreSession(s);else startFreshSession();}).catch(function(){if(msgsEl)msgsEl.innerHTML='<div style="text-align:center;padding:40px 20px;color:#9ca3af">\n  <div style="font-size:32px;margin-bottom:8px">\u26a0</div>\n  <div>Chat unavailable.</div>\n</div>';});
  }
  function closePanel(){ if(panel)panel.style.display="none"; stopPolling(); closePlusMenu(); closeEmojiPanel(); }

  // --- Send ---
  function handleSend(){
    if(!inputEl) return;
    var text=inputEl.value.trim();
    var fileMsg=pendingFile?"["+( pendingFile.type==="image"?"Image":"Video")+": "+pendingFile.name+" - Upload pending]":"";
    var fullText=(text+(fileMsg?"\n"+fileMsg:"")).trim();
    if(!fullText||!state.conversationId||!state.sessionToken) return;
    if(fullText.length>2000){alert("Message too long (max 2000).");return;}
    hideTags(); clearPendingFile();
    sendBtn.disabled=true; sendBtn.textContent="\u2026"; inputEl.value=""; inputEl.style.height="36px";
    api("/receive-widget-message",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({conversation_id:state.conversationId,session_token:state.sessionToken,content:fullText})}).then(function(res){if(!res.ok||!res.body||!res.body.success)appendMessageObj({id:"err-"+Date.now(),role:"system",content:(res.body&&res.body.error)||"Failed to send.",created_at:new Date().toISOString()});}).catch(function(){appendMessageObj({id:"err-"+Date.now(),role:"system",content:"Network error.",created_at:new Date().toISOString()});}).then(function(){sendBtn.disabled=false;sendBtn.textContent="Send";state.fallbackShownForConversation=false;state.thinkingStartTime=null;if(!state.pollInterval&&state.conversationId)startPolling();});
  }

  // --- Bubble ---
  bubble.addEventListener("click",function(){if(panel&&panel.style.display!=="none")closePanel();else openPanel();});
  api("/get-public-widget-config?channel_id="+encodeURIComponent(channelId),{method:"GET"}).then(function(res){if(res.ok&&res.body&&res.body.success&&res.body.data&&res.body.data.widget_config){config=res.body.data;state.online=isOnline();applyColor(getPrimary());}}).catch(function(){});

  console.log("[NexusAI widget] Widget v1.2.1 loaded (resize fix), channel:", channelId);
  console.log("[NexusAI widget] NOTE: File upload is simulated only (Widget MVP). No real upload to server.");
})();