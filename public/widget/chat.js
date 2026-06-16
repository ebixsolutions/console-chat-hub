/* Embeddable chat widget loader (placeholder).
 * The real chat UI and transport will be wired in later steps.
 */
(function () {
  if (window.__supportChatLoaded) return;
  window.__supportChatLoaded = true;

  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Open chat");
  btn.textContent = "💬";
  Object.assign(btn.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    width: "56px",
    height: "56px",
    borderRadius: "9999px",
    border: "none",
    background: "#111827",
    color: "#fff",
    fontSize: "24px",
    cursor: "pointer",
    boxShadow: "0 10px 25px rgba(0,0,0,.2)",
    zIndex: "2147483647",
  });

  btn.addEventListener("click", function () {
    // Placeholder: real panel mounts here.
    alert("Chat widget placeholder — UI coming soon.");
  });

  document.body.appendChild(btn);
})();
