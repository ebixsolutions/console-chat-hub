# Codex Implementation Prompt

## AI Commerce Coach / NexusAI

## Task B1 Implementation


---

You are the lead engineer implementing B1 for:

```
AI Commerce Coach / NexusAI AI Chatbot
```

Repository:

```
ebixsolutions/console-chat-hub
```


---

# Read First

Before modifying code, read:

```
/docs/CODEX_CONTEXT.md

/docs/B1_CHANGE_CONTRACT.md
```

Understand:

- architecture
- frozen boundaries
- acceptance criteria
- security requirements


---

# Current State

Completed:

```
A1
FROZEN PASS

A2
FROZEN PASS

A3
CLOSED
```


Current task:

```
B1

Industry Agent Registry
+
Industry Schema Framework
```


---

# Required Workflow


## Step 1 — Source Analysis

Inspect:

```
supabase/functions/generate-reply/index.ts

supabase/functions/_shared/

commerce-semantic-interpreter.ts

commerce-semantic-frame.ts

commerce-state-runtime.ts

commerce-state-contract.ts

commerce-capability-runtime.ts
```


Return:

1. Current dependency chain
2. Affected files
3. Proposed implementation location


Do not modify files before this analysis.


---

# Step 2 — Implementation


Implement:

## Industry Registry

Requirements:

- resolve industry identifier
- map industry to profile
- bind schema contract


## Industry Schema Framework

Requirements:

- reusable schema contract
- validation boundary
- no hardcoded single-industry runtime


## Home Appliance Profile v1

Support:

```
product
model
capacity
installation
delivery
engineering
payment
warranty
```


---

# Architectural Rules

Must preserve:

```
generate-reply

↓

semantic interpreter

↓

semantic frame

↓

commerce state runtime

↓

capability runtime
```


Do not create:

- parallel runtime
- duplicate state model
- separate chatbot implementation


---

# Forbidden Changes

Do NOT modify:

```
receive-widget-message
```

Do NOT break:

```
A3 semantic runtime contract
```


---

# Security Requirements

Verify:

- tenant isolation
- RLS preservation
- authorization boundary
- no unsafe mutation
- no ghost entity creation


---

# Testing Requirements


Verify:

## Registry

```
industry id
→ profile resolution
```


## Schema

```
profile
→ schema validation
```


## Runtime

```
industry layer
→ canonical semantic frame
→ A3 runtime
```


## Regression

Existing:

```
A1
A2
A3
```

behaviour must remain unchanged.


---

# Final Response Required

Return only:

```
COMPLETED FUNCTIONAL IMPLEMENTATION

Changed files:

Validation results:

Rollback:

Final status:
```

Do not provide progress reports.
Do not create intermediate QA documents.
Do not modify unrelated files.