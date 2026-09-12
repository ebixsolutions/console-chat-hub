# B2 Change Contract

## Project

AI Commerce Coach / NexusAI AI Chatbot


## Task

B2 — Pre-Send Conversion Supervisor


## Status

DRAFT → READY FOR IMPLEMENTATION CONTRACT REVIEW


---

# Objective

Implement a global conversion correctness supervisor
before AI response delivery.

The supervisor validates the proposed response against:

- canonical commerce state
- conversion state
- latest customer corrections
- transaction reality
- industry profile/schema context

The goal is preventing incorrect conversion guidance,
false lifecycle claims, stale information reuse,
and unnecessary customer friction.


---

# Architecture Position

Existing flow:

generate-reply

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

↓

B2 Pre-Send Conversion Supervisor

↓

Final Response


---

# Dependencies

## A3 Runtime

B2 must preserve:

- semantic interpreter
- semantic frame
- authority routing
- canonical commerce state


## B1 Industry Layer

B2 may consume:

- industry identifier
- industry profile
- schema validation result
- conversion state


---

# Frozen Components

DO NOT MODIFY:

- receive-widget-message
- A3 semantic runtime contract
- canonical commerce state model
- authority routing boundary
- tenant isolation boundary


---

# Core Responsibilities

## 1. Known Answer Protection

Prevent:

- asking already-known information again


## 2. Correction Supersession

Latest customer correction wins.

Prevent:

- old value overriding new value


## 3. Cancellation Protection

Prevent:

- cancelled item/status being restored


## 4. Quote Reality Protection

Prevent:

- historical quote treated as current quote


## 5. Transaction State Protection

Prevent:

- quotation treated as confirmed order


## 6. Action Reality Protection

Prevent:

- unfinished action claimed as completed


---

# Acceptance Criteria

## AC-01 Pre-send interception

A draft response must pass through B2 before delivery.


## AC-02 Known context protection

System must not request facts already available in canonical state.


## AC-03 Correction priority

Latest valid customer correction overrides previous values.


## AC-04 Transaction truthfulness

Response cannot claim:

- confirmed order
- completed action
- executed process

unless state proves it.


## AC-05 Quote lifecycle protection

Historical quotation cannot become current quotation without validation.


## AC-06 Industry compatibility

B2 must work with B1 industry profiles without creating
industry-specific duplicate logic.


## AC-07 Security boundary

Preserve:

- authentication
- authorization
- tenant isolation
- RLS
- guarded persistence


## AC-08 Rollback safety

B2 must be removable without breaking:

- A1
- A2
- A3
- B1


---

# Affected Files

Authoritative list:

TBD after repository dependency tracing.

Expected investigation areas:

- generate-reply pipeline
- response planner
- commerce state runtime
- conversion state logic
- B1 industry adapter integration


No modification allowed before file impact confirmation.


---

# Security Requirements

Required:

- Tenant isolation preserved
- No unsafe mutation
- No ghost entity creation
- No invented transaction state
- No authority bypass


---

# Testing Requirements

Required:

- stale information prevention
- correction overwrite prevention
- cancellation handling
- quotation lifecycle validation
- confirmed-order protection
- tenant boundary validation
- rollback validation


---

# Rollback

Rollback must:

- remove B2 changes only
- preserve B1 merged state
- preserve A3 runtime


Rollback method:

TBD after implementation commit.


---

# Final Gate

B2 COMPLETE only when:

- Acceptance Criteria PASS
- Production smoke PASS
- Security boundary PASS
- Tenant isolation PASS
- Rollback PASS
- No frozen component violation

