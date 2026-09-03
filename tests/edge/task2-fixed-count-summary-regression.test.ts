import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyCanonicalConversationTurn } from "../../supabase/functions/_shared/conversation-semantic-contract.ts";
import { resolvePriorGroundedTransform } from "../../supabase/functions/_shared/prior-grounded-transform.ts";

const meta={source_message_id:"11111111-1111-4111-8111-111111111111",citations:[{document_id:"doc",chunk_id:"chunk",label:"src",source_type:"Other",relevance:"high",chunk_type:"full_content"}],citation_lineage:{selected_document_id:"doc",evidence_chunk_ids:["chunk"],evidence_count:1}};
Deno.test("T12 confirmed-data two-point request is prior-grounded summary",()=>{
 const latest="根據已確認資料列兩點。";
 const h=[{role:"visitor",content:latest},{role:"assistant",content:"你現在問的是香港的冷氣機。",metadata:{response_route:"conversation_memory"}},{role:"visitor",content:"回到繁體中文，不要增加新資料。"},{role:"assistant",content:"回收與送貨／安裝分開進行；舊電器須獨立放置。",metadata:meta}];
 const r=classifyCanonicalConversationTurn(latest,h);
 assertEquals(r.operation,"SUMMARIZE"); assertEquals(r.evidence_authority,"PRIOR_GROUNDED_ANSWER"); assertEquals(r.requires_new_kb_retrieval,false);
 const t=resolvePriorGroundedTransform(latest,h);
 assertEquals(t?.operation,"SUMMARIZE"); assertEquals(t?.requested_summary_count,2);
});
