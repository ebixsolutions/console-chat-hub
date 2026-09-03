import { classifyHandoffIntent } from "../../supabase/functions/_shared/conversation-intelligence.ts";

Deno.test("human-support availability question is informational, not explicit R1", () => {
  const tw = classifyHandoffIntent("真人客服幾點有人？");
  if (tw.kind !== "question_about_human_support" || tw.explicit_request) throw new Error(JSON.stringify(tw));

  const cn = classifyHandoffIntent("人工客服几点有人？");
  if (cn.kind !== "question_about_human_support" || cn.explicit_request) throw new Error(JSON.stringify(cn));

  const en = classifyHandoffIntent("What hours is human support available?");
  if (en.kind !== "question_about_human_support" || en.explicit_request) throw new Error(JSON.stringify(en));
});

Deno.test("present human request remains explicit R1", () => {
  const tw = classifyHandoffIntent("現在我要真人客服。");
  if (tw.kind !== "explicit_now" || !tw.explicit_request) throw new Error(JSON.stringify(tw));

  const en = classifyHandoffIntent("I want a human agent now");
  if (en.kind !== "explicit_now" || !en.explicit_request) throw new Error(JSON.stringify(en));
});
