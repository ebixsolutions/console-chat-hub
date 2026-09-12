# AI Commerce Coach Codex Context

## Project

AI Commerce Coach / NexusAI AI Chatbot


## Repository

```text
ebixsolutions/console-chat-hub
```


## Engineering Role

You are the implementation engineer for AI Commerce Coach.

Your responsibility:

- Read authoritative source
- Trace existing runtime flow
- Implement only approved scope
- Preserve frozen architecture
- Run required validation
- Provide implementation result


---

# Current State

## Completed

### A1

```text
FROZEN PASS
```

### A2

```text
FROZEN PASS
```

### A3

```text
CLOSED
```

A3 established the semantic runtime foundation:

```text
User Conversation

        ↓

Semantic Interpreter

        ↓

Canonical Semantic Frame

        ↓

Authority Router

        ↓

Commerce State Runtime

        ↓

Capability Runtime

        ↓

Response Planner
```


---

# Current Task

## B1

```text
Industry Agent Registry
+
Industry Schema Framework
```


## Objective

Build a scalable industry layer without creating separate chatbots.

The architecture goal:

```text
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

# Frozen Components

## DO NOT MODIFY

```text
receive-widget-message
```

Reason:

Frozen runtime boundary.


## A3 Semantic Runtime Contract

Do not break:

```text
semantic interpreter

semantic frame

authority routing

commerce state model

capability runtime
```


---

# B1 Scope

## 1. Industry Agent Registry

Responsible for:

```text
industry identifier

        ↓

industry profile resolution

        ↓

schema binding
```


## 2. Industry Schema Framework

Provide reusable schema contracts.

The first reference implementation:

```text
Home Appliance Profile v1
```


Expected domain fields:

```text
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

# Architecture

Current runtime:

```text
generate-reply

        ↓

commerce-semantic-interpreter

        ↓

commerce-semantic-frame

        ↓

commerce-state-runtime

        ↓

capability-runtime
```


B1 must integrate above this architecture.

Do not create a parallel runtime path.


---

# Security Rules

Mandatory:

- Tenant isolation preserved
- RLS preserved
- Authorization boundaries preserved
- No direct unsafe mutation
- No ghost entity creation
- No invented commerce state
- No bypass of authority routing


---

# Implementation Rules

Before modifying code:

1. Identify affected files
2. Explain dependency chain
3. Confirm no frozen component impact


During implementation:

- Modify only B1 scope
- Preserve existing A1/A2/A3 behaviour
- Add required tests
- Keep rollback possible


---

# Acceptance Criteria

## AC-01 Registry Resolution

PASS when:

```text
Industry identifier

↓

Correct industry profile resolved
```


---

## AC-02 Schema Validation

PASS when:

```text
Industry profile

↓

Valid schema contract

↓

Runtime accepts
```


---

## AC-03 Home Appliance Profile

PASS when:

Home Appliance Profile v1 supports:

```text
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

```text
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

- tenant isolation remains intact
- RLS remains intact
- no unauthorized data mutation occurs


---

## AC-06 Rollback Safety

PASS when:

B1 changes can be removed without affecting:

```text
A1
A2
A3
```

existing runtime.


---

# Required Final Delivery

Codex final response must include:

```text
COMPLETED FUNCTIONAL IMPLEMENTATION

+ changed files

+ validation results

+ rollback plan

+ final status
```


# Next Action

Start with:

```text
Inspect authoritative GitHub source

↓

Trace B1 insertion point

↓

Implement Industry Agent Registry

↓

Implement Industry Schema Framework

↓

Validate
```