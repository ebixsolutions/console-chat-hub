# B1 Change Contract

## Project

AI Commerce Coach / NexusAI AI Chatbot


## Repository

ebixsolutions/console-chat-hub


---

# Task

## B1 — Industry Agent Registry + Industry Schema Framework


---

# Objective

Implement a scalable industry layer that allows the global commerce runtime to support multiple industries without creating separate chatbot implementations.

Target architecture:

```
Global Conversation Engine

        ↓

Global Commerce State

        ↓

Industry Router

        ↓

Industry Profile

        ↓

Industry Schema

        ↓

Conversion Runtime
```


---

# Scope

## Included

### Industry Agent Registry

Implement:

- industry identifier registry
- industry profile lookup
- schema binding


### Industry Schema Framework

Implement:

- reusable industry schema contract
- schema validation boundary


### Reference Industry Profile

Initial implementation:

```
Home Appliance Profile v1
```

Required fields:

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

# Excluded

Do NOT implement:

- new chatbot engines
- industry-specific conversation flows
- direct database mutation
- new payment/order logic
- changes to existing A3 semantic authority model


---

# Authoritative Source

Primary source:

```
GitHub:
ebixsolutions/console-chat-hub
```

Runtime entry:

```
supabase/functions/generate-reply
```

Related modules:

```
supabase/functions/_shared/

commerce-semantic-interpreter.ts

commerce-semantic-frame.ts

commerce-state-runtime.ts

commerce-state-contract.ts

commerce-capability-runtime.ts
```


---

# Frozen Components

DO NOT MODIFY:

```
receive-widget-message
```

DO NOT BREAK:

```
A3 semantic runtime contract

semantic interpreter

semantic frame

authority routing

canonical commerce state
```


---

# Allowed Changes

Allowed:

```
Create new industry registry module

Create industry schema module

Create industry profile module

Add required runtime adapter
```

Only modify existing runtime integration when required for B1.


---

# Security Requirements

Must preserve:

- Tenant isolation
- RLS policies
- Authorization boundary
- Existing permission model

Forbidden:

- bypassing authority router
- direct unsafe mutation
- invented commerce state
- ghost entity creation


---

# Acceptance Criteria


## AC-01 Registry Resolution

Given:

```
industry identifier
```

When:

```
industry routing executes
```

Then:

```
correct industry profile is resolved
```


---

## AC-02 Schema Validation

Given:

```
industry profile
```

When:

```
schema contract validation runs
```

Then:

```
runtime accepts valid schema only
```


---

## AC-03 Home Appliance Profile

PASS when:

Home Appliance Profile v1 supports:

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

## AC-04 A3 Compatibility

PASS when:

```
Industry Layer

↓

Canonical Semantic Frame

↓

Existing A3 Runtime
```

without changing:

- semantic authority
- routing rules
- canonical state behaviour


---

## AC-05 Security Boundary

PASS when:

- tenant isolation unchanged
- RLS unchanged
- unauthorized mutation impossible


---

## AC-06 Rollback Safety

PASS when:

B1 changes can be removed without affecting:

```
A1
A2
A3
```

runtime.


---

# Validation Required

Must verify:

```
source compile

runtime compatibility

schema validation

industry resolution

security boundary

rollback safety
```


---

# Final Status Rules

READY only when:

```
Implementation PASS

Validation PASS

Rollback verified
```


Final delivery format:

```
COMPLETED FUNCTIONAL IMPLEMENTATION

+ changed files

+ validation results

+ rollback

+ final status
```