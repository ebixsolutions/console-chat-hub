from pathlib import Path
import subprocess

repo_file = "public/widget/chat.js"
base_ref = "42bc9fbdbef69a7d2254ab90702f406e1b9fd478^"
base = subprocess.check_output(["git", "show", f"{base_ref}:{repo_file}"], text=True)
old = '''    if (value === "waiting") {
      state.handoffRequested = true;
      hideTyping();
      state.thinkingStartTime = null;
      state.fallbackShownForConversation = true;
      el.classList.add("waiting");
      el.textContent =
        "Human support requested. You are waiting for a team member. You can continue sending messages here.";
      updateTicket(state.conversationId, "human_needed", null);
      return;
    }'''
new = '''    if (value === "waiting") {
      state.handoffRequested = true;
      hideTyping();
      state.thinkingStartTime = null;
      state.fallbackShownForConversation = true;
      el.classList.add("waiting");
      var queuePosition = humanSupport && Number.isInteger(humanSupport.queue_position) && humanSupport.queue_position > 0
        ? humanSupport.queue_position
        : null;
      var customersAhead = humanSupport && Number.isInteger(humanSupport.customers_ahead) && humanSupport.customers_ahead >= 0
        ? humanSupport.customers_ahead
        : null;
      var etaMinutes = humanSupport && Number.isInteger(humanSupport.estimated_wait_minutes) && humanSupport.estimated_wait_minutes > 0
        ? humanSupport.estimated_wait_minutes
        : null;
      var queueText = "Human support requested. You are waiting for a team member.";
      if (queuePosition !== null) queueText += " Queue position: #" + queuePosition + ".";
      if (customersAhead !== null) queueText += " Customers ahead: " + customersAhead + ".";
      if (etaMinutes !== null) queueText += " Estimated wait: about " + etaMinutes + " minute" + (etaMinutes === 1 ? "" : "s") + ".";
      else queueText += " Estimated wait time is not available yet.";
      queueText += " You can continue sending messages here.";
      el.textContent = queueText;
      updateTicket(state.conversationId, "human_needed", null);
      return;
    }'''
if base.count(old) != 1:
    raise SystemExit(f"expected one waiting block, got {base.count(old)}")
patched = base.replace(old, new, 1)
if len(patched) < 50000:
    raise SystemExit("restored widget unexpectedly short")
for needle in [
    "Queue position: #",
    "Customers ahead:",
    "Estimated wait time is not available yet.",
    "function uploadAttachment(file)",
    "function insertEmoji(emoji)",
    "function executePoll()",
    "function tryRestoreSession(stored)",
]:
    if needle not in patched:
        raise SystemExit(f"missing postcondition: {needle}")
Path(repo_file).write_text(patched)
print("TASK5_1_WIDGET_EXACT_PATCH=PASS")
