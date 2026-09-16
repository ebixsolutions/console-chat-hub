#!/usr/bin/env python3
"""C3 validation-only production runner.

This program never deploys, migrates, publishes, or edits runtime configuration.  It creates
only marked widget fixtures, exercises the existing live runtime, records authoritative
readback, and removes exact owned IDs in a finally block.  A cleanup-only invocation can
resume from the durable fixture manifest after runner interruption.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PROJECT = "nrfxhqabwblzxoushgnm"
REPOSITORY = "ebixsolutions/console-chat-hub"
ORIGIN = "https://console-chat-hub.lovable.app"
CHANNEL = "b0000000-0000-0000-0000-000000000001"
SCHEMA = "ai-abc-c3-validation-evidence-1.0.0"
CONTRACT_VERSION = "ai-abc-c3-release-acceptance-2026-09-16.1"
LIVE_EXPECTED = {
    "generate-reply": (108, "f5c85c002c99ca7f094d1e1c9b1cb7349e44e73a159a8970b78a6b2a2bf7e397"),
    "agent-assist": (43, "eeadc5c9dfb35c51e8778756fcae96ff0c0fc68fc68599ade565ef7479e4e4cb"),
}

DB_READBACK_ENDPOINT = "projects/{project}/database/query"
DB_READBACK_SAFE_NAME = "management_database_query_read_only"
# The Management API currently documents 201 for this POST. 200 is retained as the
# previously observed compatible response, but no other 2xx status is accepted.
DB_READBACK_SUCCESS_STATUSES = (200, 201)
DB_SECURITY_ASSERTIONS = (
    "c3_migration_applied",
    "memory_table_exists",
    "event_table_exists",
    "memory_rls",
    "event_rls",
    "staff_membership_policy",
    "c3_rpc_exists",
    "c3_service_role_execute",
    "c3_public_denied",
    "c3_anon_denied",
    "c3_authenticated_denied",
    "lineage_trigger",
    "c3_handoff_trigger",
    "handoff_event_exists",
    "handoff_event_rls",
    "c2_rpc_exists",
    "c2_service_role_execute",
    "c2_public_denied",
    "c2_anon_denied",
    "c2_authenticated_denied",
    "c2_handoff_trigger",
    "c2_trigger_function_exists",
    "c2_trigger_public_denied",
    "c2_trigger_anon_denied",
    "c2_trigger_authenticated_denied",
    "c2_trigger_service_role_denied",
)


def safe_type(value: object) -> str:
    if value is None:
        return "null"
    return type(value).__name__


def validate_db_security_response(status: int, payload: object, emit=print) -> dict[str, bool]:
    endpoint = DB_READBACK_SAFE_NAME
    if status not in DB_READBACK_SUCCESS_STATUSES:
        emit(f"C3_DB_READBACK|endpoint={endpoint}|method=POST|status={status}|result=FAIL")
        raise RuntimeError(f"db_security_readback_unavailable:http_{status}")

    row_count = len(payload) if isinstance(payload, list) else -1
    row = payload[0] if isinstance(payload, list) and len(payload) == 1 else None
    present = sum(1 for key in DB_SECURITY_ASSERTIONS if isinstance(row, dict) and key in row)
    if not isinstance(row, dict) or present != len(DB_SECURITY_ASSERTIONS):
        emit(
            "C3_DB_PAYLOAD|"
            f"status={status}|top_level_type={safe_type(payload)}|row_count={row_count}|"
            f"required_key_count={len(DB_SECURITY_ASSERTIONS)}|present_required_keys={present}|result=FAIL"
        )
        emit(f"C3_DB_READBACK|endpoint={endpoint}|method=POST|status={status}|result=FAIL")
        raise RuntimeError("db_security_readback_invalid_payload")

    failures = []
    for name in DB_SECURITY_ASSERTIONS:
        actual = row.get(name)
        result = "PASS" if actual is True else "FAIL"
        emit(f"C3_DB_ASSERT|name={name}|expected=true|actual={str(actual).lower()}|result={result}")
        if actual is not True:
            failures.append(name)
    emit(
        f"C3_DB_READBACK|endpoint={endpoint}|method=POST|status={status}|"
        f"result={'PASS' if not failures else 'FAIL'}"
    )
    if failures:
        raise RuntimeError("db_security_drift:" + ",".join(failures))
    return {name: True for name in DB_SECURITY_ASSERTIONS}


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def classify_runtime_wait(*, allow_human_suppression: bool, customer_persisted: bool,
                          new_assistant_count: int, handoff_present: bool,
                          receive_control_state: str | None, receive_ai_reply_pending: bool | None,
                          conversation_status: str | None, resolved_at: str | None,
                          deadline_expired: bool) -> str:
    """Classify a widget send from persisted evidence, never from HTTP acceptance alone."""
    if new_assistant_count > 1:
        return "duplicate_assistant_response"
    if new_assistant_count == 1 and customer_persisted and deadline_expired:
        return "assistant_persisted_after_deadline"
    if new_assistant_count == 1 and customer_persisted:
        return "assistant_persisted"
    if (allow_human_suppression and customer_persisted and handoff_present
            and receive_control_state == "human_control" and receive_ai_reply_pending is False
            and conversation_status == "pending" and resolved_at is None):
        return "expected_human_control_suppression"
    if deadline_expired:
        return "assistant_response_timeout" if customer_persisted else "customer_persistence_timeout"
    return "continue_waiting"


def request(url: str, method: str = "GET", body: object | None = None, headers: dict[str, str] | None = None, timeout: int = 120):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    merged = {"User-Agent": "ai-abc-c3-validation-only/1.0", **(headers or {})}
    req = urllib.request.Request(url, data=data, method=method, headers=merged)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read().decode(errors="replace")
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode(errors="replace")
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"error": raw[:1000]}
        return error.code, payload


class Harness:
    def __init__(self, out: Path, contract_path: Path, artifact_root: Path):
        self.out = out
        self.contract_path = contract_path
        self.artifact_root = artifact_root
        self.manifest_path = out / "fixture-manifest.json"
        self.evidence_path = out / "evidence.json"
        self.access_token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
        self.base = os.environ.get("VITE_SUPABASE_FUNCTIONS_URL", f"https://{PROJECT}.supabase.co/functions/v1")
        self.supabase_url = os.environ.get("VITE_SUPABASE_URL", f"https://{PROJECT}.supabase.co")
        self.public_key = ""
        self.server_key = ""
        self.staff_jwt = ""
        self.staff_user_id = ""
        run_id = os.environ.get("GITHUB_RUN_ID", "local")
        attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
        head = os.environ.get("C3_EXPECTED_HEAD", "local")
        self.manifest = {
            "schema_version": "ai-abc-c3-fixture-manifest-1.0.0",
            "project": PROJECT,
            "run_id": run_id,
            "attempt": attempt,
            "marker": f"c3-validation-{run_id}-{attempt}-{head[:12]}",
            "exclude_training": True,
            "created_at": utc_now(),
            "conversations": [],
            "cleanup_attempts": [],
        }
        self.contract_raw = contract_path.read_bytes()
        self.contract = json.loads(self.contract_raw)
        self.started_at = utc_now()

    def persist_manifest(self) -> None:
        write_json(self.manifest_path, self.manifest)

    def management(self, path: str, method="GET", body=None):
        if not self.access_token:
            raise RuntimeError("credential_missing:SUPABASE_ACCESS_TOKEN")
        return request(
            f"https://api.supabase.com/v1/{path.lstrip('/')}", method, body,
            {"Authorization": f"Bearer {self.access_token}", "Content-Type": "application/json"},
        )

    def load_keys(self) -> None:
        status, rows = self.management(f"projects/{PROJECT}/api-keys?reveal=true")
        if status != 200 or not isinstance(rows, list):
            raise RuntimeError(f"project_api_keys_unavailable:http_{status}")
        for row in rows:
            value = row.get("api_key") or row.get("key") or row.get("value")
            kind = str(row.get("type") or "").lower()
            if value and kind == "publishable" and not self.public_key:
                self.public_key = value
            if value and kind == "secret" and not self.server_key:
                self.server_key = value
        if not self.public_key or not self.server_key:
            raise RuntimeError("project_api_keys_incomplete")

    def authenticate_staff(self) -> None:
        email = os.environ.get("FINAL_SMOKE_AGENT_EMAIL", "")
        password = os.environ.get("FINAL_SMOKE_AGENT_PASSWORD", "")
        if not email or not password:
            raise RuntimeError("credential_missing:FINAL_SMOKE_AGENT_EMAIL_OR_PASSWORD")
        status, payload = request(
            f"{self.supabase_url}/auth/v1/token?grant_type=password", "POST",
            {"email": email, "password": password},
            {"apikey": self.public_key, "Content-Type": "application/json"},
        )
        if status != 200 or not isinstance(payload, dict) or not payload.get("access_token"):
            raise RuntimeError(f"staff_authentication_failed:http_{status}")
        self.staff_jwt = payload["access_token"]
        self.staff_user_id = str((payload.get("user") or {}).get("id") or "")
        try:
            self.staff_user_id = str(uuid.UUID(self.staff_user_id))
        except (ValueError, TypeError, AttributeError) as error:
            raise RuntimeError("staff_identity_uuid_missing") from error

    def rest(self, table: str, params=None, method="GET", body=None, prefer=None):
        url = f"{self.supabase_url}/rest/v1/{table}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"apikey": self.server_key, "Authorization": f"Bearer {self.server_key}", "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        return request(url, method, body, headers)

    def staff_rest(self, table: str, params=None):
        if not self.staff_jwt:
            raise RuntimeError("staff_identity_not_authenticated")
        url = f"{self.supabase_url}/rest/v1/{table}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        return request(url, headers={
            "apikey": self.public_key,
            "Authorization": f"Bearer {self.staff_jwt}",
            "Content-Type": "application/json",
        })

    def function(self, name: str, body: object, headers=None, timeout=120):
        return request(
            f"{self.base}/{name}", "POST", body,
            {"Origin": ORIGIN, "Content-Type": "application/json", **(headers or {})}, timeout,
        )

    def create_fixture(self, purpose: str):
        metadata = {
            "c3_validation_marker": self.manifest["marker"],
            "c3_validation_purpose": purpose,
            "exclude_training": True,
            "widget_live_test": True,
            "fictional_test": True,
            "test_owner": "AI-ABC-C3 Director validation-only runner",
            "owner_user_id": self.staff_user_id,
        }
        status, payload = self.function("create-visitor-session", {"channel_id": CHANNEL, "visitor_metadata": metadata})
        if status != 200 or not payload or payload.get("success") is not True:
            raise RuntimeError(f"fixture_create_failed:{purpose}:http_{status}")
        fixture = {
            "conversation_id": payload["data"]["conversation_id"],
            "session_token": payload["data"]["session_token"],
            "purpose": purpose,
            "created_at": utc_now(),
            "customer_source_message_ids": [],
            "assistant_message_ids": [],
        }
        status, rows = self.rest("conversations", {
            "id": f"eq.{fixture['conversation_id']}", "select": "visitor_session_id",
        })
        if status != 200 or not isinstance(rows, list) or len(rows) != 1 or not rows[0].get("visitor_session_id"):
            raise RuntimeError("fixture_visitor_session_readback_failed")
        fixture["visitor_session_id"] = rows[0]["visitor_session_id"]
        self.manifest["conversations"].append(fixture)
        self.persist_manifest()
        return fixture

    def poll(self, fixture):
        return self.function("widget-poll-messages", {"conversation_id": fixture["conversation_id"], "session_token": fixture["session_token"]})

    def send(self, fixture, content: str, timeout_seconds=120, *, scenario_id="unspecified",
             allow_human_suppression=False):
        before_status, before_payload = self.poll(fixture)
        before = []
        if before_status == 200 and before_payload and before_payload.get("success"):
            before = [m for m in before_payload["data"].get("messages", []) if m.get("role") == "assistant"]
        key = str(uuid.uuid4())
        sent_at = utc_now()
        wait_started = time.time()
        deadline = wait_started + timeout_seconds
        status, payload = self.function(
            "receive-widget-message",
            {"conversation_id": fixture["conversation_id"], "session_token": fixture["session_token"], "content": content},
            {"idempotency-key": key}, timeout_seconds,
        )
        if status >= 300 or not payload or payload.get("success") is not True:
            raise RuntimeError(f"widget_send_failed:http_{status}:{payload}")
        send_accepted_at = utc_now()
        receive_data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        receive_control_state = receive_data.get("control_state")
        receive_ai_reply_pending = receive_data.get("ai_reply_pending")
        latest = None
        new_assistant_count = 0
        customer = None
        handoff = None
        conversation = None
        poll_attempts = 0
        last_poll_success_at = None
        last_poll_error = "none"
        terminal = "continue_waiting"
        ai_generating = None
        last_message_ids_types = "none"
        while time.time() < deadline:
            poll_attempts += 1
            poll_status, polled = self.poll(fixture)
            if poll_status == 200 and polled and polled.get("success"):
                last_poll_success_at = utc_now()
                last_poll_error = "none"
                polled_messages = polled["data"].get("messages", [])
                assistants = [m for m in polled_messages if m.get("role") == "assistant"]
                new_assistant_count = max(0, len(assistants) - len(before))
                ai_generating = bool(polled["data"].get("ai_generating"))
                last_message_ids_types = ",".join(
                    f"{m.get('id', 'unknown')}:{m.get('role', 'unknown')}" for m in polled_messages[-4:]
                ) or "none"
                if new_assistant_count:
                    latest = assistants[-1]
            else:
                last_poll_error = f"widget_poll_http_{poll_status}"

            read_status, messages = self.staff_rest("messages", {
                "conversation_id": f"eq.{fixture['conversation_id']}",
                "select": "id,role,content,metadata,created_at", "order": "created_at.desc", "limit": "12",
            })
            if read_status == 200 and isinstance(messages, list):
                customer = next((m for m in messages
                    if m.get("role") in ("visitor", "customer", "user")
                    and (m.get("metadata") or {}).get("client_message_id") == key), customer)
                if customer and customer.get("id") and customer["id"] not in fixture["customer_source_message_ids"]:
                    fixture["customer_source_message_ids"].append(customer["id"])
                    self.persist_manifest()
            else:
                last_poll_error = f"staff_message_readback_http_{read_status}"

            if allow_human_suppression and customer:
                conversation_status, conversations = self.staff_rest("conversations", {
                    "id": f"eq.{fixture['conversation_id']}", "select": "status,resolved_at",
                })
                handoff_status, handoffs = self.staff_rest("handoff_event", {
                    "conversation_id": f"eq.{fixture['conversation_id']}",
                    "select": "id,source_message_id,escalation_rule,safe_reply_content,created_at",
                    "order": "created_at.desc", "limit": "1",
                })
                if conversation_status == 200 and isinstance(conversations, list) and len(conversations) == 1:
                    conversation = conversations[0]
                if handoff_status == 200 and isinstance(handoffs, list) and handoffs:
                    handoff = handoffs[0]

            terminal = classify_runtime_wait(
                allow_human_suppression=allow_human_suppression,
                customer_persisted=bool(customer), new_assistant_count=new_assistant_count,
                handoff_present=bool(handoff and handoff.get("escalation_rule") == "R1"),
                receive_control_state=receive_control_state,
                receive_ai_reply_pending=receive_ai_reply_pending,
                conversation_status=(conversation or {}).get("status"),
                resolved_at=(conversation or {}).get("resolved_at"), deadline_expired=False,
            )
            if terminal != "continue_waiting":
                break
            time.sleep(1.25)
        deadline_expired = terminal == "continue_waiting" and latest is None
        if deadline_expired:
            final_poll_status, final_polled = self.poll(fixture)
            poll_attempts += 1
            if final_poll_status == 200 and final_polled and final_polled.get("success"):
                last_poll_success_at = utc_now()
                polled_messages = final_polled["data"].get("messages", [])
                assistants = [m for m in polled_messages if m.get("role") == "assistant"]
                new_assistant_count = max(0, len(assistants) - len(before))
                ai_generating = bool(final_polled["data"].get("ai_generating"))
                last_message_ids_types = ",".join(
                    f"{m.get('id', 'unknown')}:{m.get('role', 'unknown')}" for m in polled_messages[-4:]
                ) or "none"
                if new_assistant_count:
                    latest = assistants[-1]
            else:
                last_poll_error = f"widget_poll_http_{final_poll_status}"
        terminal = classify_runtime_wait(
            allow_human_suppression=allow_human_suppression,
            customer_persisted=bool(customer), new_assistant_count=new_assistant_count,
            handoff_present=bool(handoff and handoff.get("escalation_rule") == "R1"),
            receive_control_state=receive_control_state,
            receive_ai_reply_pending=receive_ai_reply_pending,
            conversation_status=(conversation or {}).get("status"),
            resolved_at=(conversation or {}).get("resolved_at"), deadline_expired=deadline_expired,
        )
        elapsed_ms = int((time.time() - wait_started) * 1000)
        if conversation is None:
            conversation_status, conversations = self.staff_rest("conversations", {
                "id": f"eq.{fixture['conversation_id']}", "select": "status,resolved_at",
            })
            if conversation_status == 200 and isinstance(conversations, list) and len(conversations) == 1:
                conversation = conversations[0]
        memory_status, memory_rows = self.staff_rest("conversation_memory_state", {
            "conversation_id": f"eq.{fixture['conversation_id']}", "select": "revision",
        })
        commerce_status, commerce_rows = self.staff_rest("conversation_commerce_state", {
            "conversation_id": f"eq.{fixture['conversation_id']}", "select": "revision",
        })
        memory_revision = memory_rows[0].get("revision") if memory_status == 200 and isinstance(memory_rows, list) and memory_rows else None
        commerce_revision = commerce_rows[0].get("revision") if commerce_status == 200 and isinstance(commerce_rows, list) and commerce_rows else None
        result = "PASS" if terminal in ("assistant_persisted", "expected_human_control_suppression") else "FAIL"
        print(
            "C3_RUNTIME_WAIT|"
            f"scenario={scenario_id}|source_message_id={(customer or {}).get('id') or 'unavailable'}|"
            f"send_accepted_at={send_accepted_at}|customer_persisted_at={(customer or {}).get('created_at') or 'unavailable'}|"
            f"poll_attempts={poll_attempts}|last_poll_success_at={last_poll_success_at or 'none'}|"
            f"last_poll_error={last_poll_error}|assistant_count={new_assistant_count}|"
            f"receive_control_state={receive_control_state or 'unknown'}|receive_ai_reply_pending={str(receive_ai_reply_pending).lower()}|"
            f"ai_generating={str(ai_generating).lower()}|conversation_status={(conversation or {}).get('status') or 'unknown'}|"
            f"terminal_status={terminal}|elapsed_ms={elapsed_ms}|result={result}"
        )
        if result == "FAIL":
            print(
                "C3_RUNTIME_TIMEOUT|"
                f"scenario={scenario_id}|source_message_id={(customer or {}).get('id') or 'unavailable'}|"
                f"last_messages={last_message_ids_types}|route={((latest or {}).get('metadata') or {}).get('response_route') or 'unavailable'}|"
                f"memory_revision={memory_revision}|commerce_revision={commerce_revision}|"
                f"expected_deadline_ms={timeout_seconds * 1000}|poll_count={poll_attempts}|"
                f"receive_control_state={receive_control_state or 'unknown'}|receive_ai_reply_pending={str(receive_ai_reply_pending).lower()}|"
                f"assistant_count={new_assistant_count}|ai_generating={str(ai_generating).lower()}|"
                f"conversation_status={(conversation or {}).get('status') or 'unknown'}|result=FAIL"
            )
        if latest and latest.get("id") and latest["id"] not in fixture["assistant_message_ids"]:
            fixture["assistant_message_ids"].append(latest["id"])
            self.persist_manifest()
        if terminal not in ("assistant_persisted", "expected_human_control_suppression"):
            raise RuntimeError(terminal)
        if not customer or not customer.get("id"):
            raise RuntimeError("authoritative_customer_message_readback_missing")
        if terminal == "expected_human_control_suppression":
            return {"sent_at": sent_at, "customer": customer, "assistant": None,
                    "suppressed": True, "conversation": conversation, "handoff": handoff,
                    "receive_control_state": receive_control_state,
                    "receive_ai_reply_pending": receive_ai_reply_pending}
        status, messages = self.staff_rest("messages", {
            "conversation_id": f"eq.{fixture['conversation_id']}",
            "select": "id,role,content,metadata,created_at", "order": "created_at.desc", "limit": "12",
        })
        if status != 200 or not isinstance(messages, list):
            raise RuntimeError(f"staff_message_readback_failed:http_{status}")
        assistant = next((m for m in messages if m.get("id") == latest.get("id")), latest)
        if not assistant or not assistant.get("id"):
            raise RuntimeError("authoritative_assistant_message_readback_missing")
        self.persist_manifest()
        return {"sent_at": sent_at, "customer": customer, "assistant": assistant, "suppressed": False}

    def state_readback(self, conversation_id: str):
        memory_status, memory = self.staff_rest("conversation_memory_state", {"conversation_id": f"eq.{conversation_id}", "select": "*"})
        commerce_status, commerce = self.staff_rest("conversation_commerce_state", {"conversation_id": f"eq.{conversation_id}", "select": "*"})
        if memory_status != 200 or commerce_status != 200:
            raise RuntimeError(f"staff_state_readback_failed:memory_{memory_status}:commerce_{commerce_status}")
        return (memory[0] if isinstance(memory, list) and memory else None, commerce[0] if isinstance(commerce, list) and commerce else None)

    def scenario(self, row):
        fixture = self.create_fixture(f"scenario:{row['id']}")
        for turn in row["setup_turns"]:
            self.send(fixture, turn, scenario_id=f"{row['id']}:setup")
        observed = self.send(fixture, row["input"], scenario_id=row["id"],
                             allow_human_suppression=row["id"] == "C3-CONTROL-15")
        memory, commerce = self.state_readback(fixture["conversation_id"])
        metadata = (observed.get("assistant") or {}).get("metadata") or {}
        suppressed = observed.get("suppressed") is True
        handoff = observed.get("handoff") or {}
        conversation = observed.get("conversation") or {}
        customer_source_id = observed["customer"]["id"]
        assistant_source_id = None if suppressed else metadata.get("source_message_id")
        source_bound = suppressed or assistant_source_id == customer_source_id
        persisted_result = "suppressed_human_control" if suppressed else ("success" if source_bound else "unobserved")
        return {
            "id": row["id"], "contract_version": CONTRACT_VERSION,
            "input": row["input"], "expected": row["expected"],
            "actual_reply": "" if suppressed else observed["assistant"].get("content") or "",
            "response_route": "human_control" if suppressed else str(metadata.get("response_route") or metadata.get("route") or "normal"),
            "recall_authority": None if suppressed else metadata.get("recall_authority"),
            "recall_fact_type": None if suppressed else metadata.get("recall_fact_type"),
            "recall_reason": None if suppressed else metadata.get("recall_reason"),
            "recall_provenance": [] if suppressed else metadata.get("recall_provenance") or [],
            "customer_source_message_id": observed["customer"]["id"],
            "assistant_message_id": None if suppressed else observed["assistant"]["id"],
            "response_suppressed": suppressed,
            "suppression_evidence": ({
                "reason": "existing_explicit_R1_handoff", "handoff_event_id": handoff.get("id"),
                "receive_control_state": observed.get("receive_control_state"),
                "receive_ai_reply_pending": observed.get("receive_ai_reply_pending"),
                "handoff_source_message_id": handoff.get("source_message_id"),
                "handoff_safe_reply": handoff.get("safe_reply_content"),
                "conversation_status": conversation.get("status"), "resolved_at": conversation.get("resolved_at"),
                "assistant_after_source": False,
            } if suppressed else None),
            "memory_revision": (memory or {}).get("revision"),
            "commerce_revision": (commerce or {}).get("revision"),
            "source_binding": {
                "assistant_source_message_id": assistant_source_id,
                "memory_source_message_id": (memory or {}).get("source_message_id"),
                "commerce_source_message_id": (commerce or {}).get("source_message_id"),
                "exact_customer_source_match": source_bound,
            },
            "b2": {"persistence_result": persisted_result, "evidence": "persisted_assistant_exact_source_binding" if source_bound and not suppressed else "human_control_suppression" if suppressed else "unobserved"},
            "observed_at": utc_now(), "conversation_id": fixture["conversation_id"],
        }

    def historical_hkd_8000_probe(self):
        fixture = self.create_fixture("historical_hkd_8000_probe")
        self.send(fixture, "我幾年前聽過某型號可能是港幣8000元，但這不是目前已核實報價。")
        observed = self.send(fixture, "現在可以直接把港幣8000元當作目前官方售價嗎？")
        reply = str(observed["assistant"].get("content") or "")
        lower = reply.lower()
        guarded = any(x.lower() in lower for x in ("不可以", "不能", "唔可以", "未核實", "未確認", "歷史", "舊", "current evidence", "cannot"))
        promoted = any(x.lower() in lower for x in ("目前官方售價是8000", "已核實售價8000", "current official price is 8000"))
        return {
            "pass": guarded and not promoted, "source": "runtime_readback",
            "actual_reply": reply, "customer_source_message_id": observed["customer"]["id"],
            "assistant_message_id": observed["assistant"]["id"], "observed_at": utc_now(),
        }

    def core_smoke(self, scenarios):
        names = [
            "request_deadline_cancellation", "terminal_budget_75000_15000_90000_120000",
            "source_bound_b2_atomic_commit", "late_completion_exactly_once", "memory_initial_creation",
            "memory_incremental_update", "stale_rejection_and_fresh_retry", "idempotency_exactly_once_event",
            "wrong_tenant_rejection", "canonical_snapshot_non_null", "takeover_suppression",
            "superseded_source_rejection", "c1_current_fact_authority", "c2_handoff_precedence",
            "agent_assist_tenant_safe", "return_to_ai_explicit_only", "no_direct_persistence_bypass",
        ]
        b2_observed = all(
            row.get("b2", {}).get("persistence_result") in ("success", "idempotent")
            or (row.get("id") == "C3-CONTROL-15" and row.get("response_suppressed") is True
                and row.get("b2", {}).get("persistence_result") == "suppressed_human_control")
            for row in scenarios
        )
        memory_observed = all(isinstance(row.get("memory_revision"), int) and row["memory_revision"] >= 1 for row in scenarios)
        # Only facts that are actually present in runtime/DB readback may pass here.  Missing
        # terminal, retry, tenant-negative, or handoff observations remain explicit gaps and
        # stop the 100-turn phase instead of being inferred from source code.
        observed = {
            "source_bound_b2_atomic_commit": b2_observed,
            "memory_initial_creation": memory_observed,
            "memory_incremental_update": memory_observed and len({row["memory_revision"] for row in scenarios}) > 1,
            "canonical_snapshot_non_null": memory_observed,
            "c1_current_fact_authority": any(row["id"] == "C3-CONTROL-12" for row in scenarios),
            "c2_handoff_precedence": any(row["id"] == "C3-CONTROL-15" for row in scenarios),
        }
        return [{
            "name": name, "pass": observed.get(name, False),
            "observation": {"source": "runtime_readback" if observed.get(name, False) else "observability_gap", "observed_at": utc_now()},
        } for name in names]

    def task9_turns(self):
        source = Path("scripts/task9-tungyu-100turn-production-smoke.py").read_text()
        tree = ast.parse(source)
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "turns" for t in node.targets):
                turns = ast.literal_eval(node.value)
                if isinstance(turns, list) and len(turns) == 100:
                    return turns
        raise RuntimeError("canonical_100_turn_fixture_not_found")

    def long_run(self):
        fixture = self.create_fixture("fresh_true_100_turn")
        checkpoints = []
        observations = []
        for turn, content in enumerate(self.task9_turns(), 1):
            observed = self.send(fixture, content)
            observations.append(observed)
            if turn in (20, 50, 100):
                memory, commerce = self.state_readback(fixture["conversation_id"])
                metadata = observed["assistant"].get("metadata") or {}
                context_chars = metadata.get("generation_context_chars")
                recent_chars = metadata.get("recent_raw_chars")
                recent_count = metadata.get("recent_raw_message_count")
                checkpoints.append({
                    "turn": turn, "source_message_id": observed["customer"]["id"],
                    "memory_revision": (memory or {}).get("revision"),
                    "commerce_revision": (commerce or {}).get("revision"),
                    "memory_chars": len(json.dumps((memory or {}).get("memory"), ensure_ascii=False)),
                    "generation_context_chars": context_chars,
                    "recent_raw_chars": recent_chars,
                    "recent_window_count": recent_count,
                    "recent_window_unit": "messages",
                    "measurement_source": "runtime_observation" if all(isinstance(x, int) for x in (context_chars, recent_chars, recent_count)) else "observability_gap",
                    "response_route": str(metadata.get("response_route") or "normal"),
                })
        replies = [str(item["assistant"].get("content") or "") for item in observations]
        reply = lambda turn: replies[turn - 1]
        checks = {
            "T06_qty3_initial": "3" in reply(6) or "三" in reply(6),
            "T17_qty2_after_defer": "2" in reply(17) or "兩" in reply(17),
            "T40_address_B": ("B" in reply(40) or "Ｂ" in reply(40)) and "A座" not in reply(40),
            "T50_room_sizes": "80" in reply(50) and "100" in reply(50),
            "T55_qty2_after_topic_return": "2" in reply(55) or "兩" in reply(55),
            "T57_address_B_retained": ("B" in reply(57) or "Ｂ" in reply(57)) and "A座" not in reply(57),
            "T58_saturday": "六" in reply(58) or "Saturday" in reply(58),
            "T59_old_removal1": "1" in reply(59) or "一" in reply(59),
            "T68_ac_hp": "1匹" in reply(68) and "1.5匹" in reply(68),
            "T69_brand_not_forced": any(value in reply(69) for value in ("唔", "沒有", "不是", "並非")),
            "T71_no_5600_reuse": any(value in reply(71) for value in ("不能", "唔", "不應", "不可以")),
            "T73_4200_unverified": any(value in reply(73) for value in ("正式", "確認", "未")),
            "T90_final_qty2": "2" in reply(90) or "兩" in reply(90),
            "T96_recipient_contact": "陳太" in reply(96) and "6987" in reply(96) and ("B" in reply(96) or "Ｂ" in reply(96)),
            "T98_quotation_not_order": ("quotation" in reply(98).lower() or "報價" in reply(98)) and any(value in reply(98) for value in ("未", "不", "唔")),
        }
        return {
            "fresh": True, "conversation_id": fixture["conversation_id"],
            "transport_successes": len(observations),
            "unique_customer_source_messages": len(set(fixture["customer_source_message_ids"])),
            "customer_source_message_ids": fixture["customer_source_message_ids"],
            "assistant_persistences": len(set(fixture["assistant_message_ids"])),
            "semantic_correct": sum(1 for passed in checks.values() if passed),
            "semantic_total": len(checks),
            "semantic_checks": [{"name": name, "pass": passed, "source": "actual_assistant_reply"} for name, passed in checks.items()],
            "checkpoints": checkpoints,
            "observations": observations,
        }

    def rebuild_comparison(self, conversation_id: str):
        memory_status, memory_rows = self.staff_rest("conversation_memory_state", {"conversation_id": f"eq.{conversation_id}", "select": "*"})
        commerce_status, commerce_rows = self.staff_rest("conversation_commerce_state", {"conversation_id": f"eq.{conversation_id}", "select": "*"})
        messages_status, messages = self.staff_rest("messages", {
            "conversation_id": f"eq.{conversation_id}", "is_recalled": "eq.false", "content": "neq.__THINKING__",
            "select": "id,role,content,created_at,metadata", "order": "created_at.desc,id.desc", "limit": "500",
        })
        if memory_status != 200 or commerce_status != 200 or messages_status != 200:
            raise RuntimeError("rebuild_authoritative_readback_failed")
        if not isinstance(memory_rows, list) or len(memory_rows) != 1 or not isinstance(messages, list):
            raise RuntimeError("rebuild_authoritative_readback_shape_invalid")
        persisted = memory_rows[0]
        commerce = commerce_rows[0] if isinstance(commerce_rows, list) and commerce_rows else None
        payload = {
            "previous": None,
            "conversation_id": conversation_id,
            "company_id": persisted.get("company_id"),
            "source_message_id": persisted.get("source_message_id"),
            "commerce_state_revision": (commerce or {}).get("revision"),
            "commerce_state": (commerce or {}).get("state"),
            "newest_first": messages,
            "visitor_turn_count": sum(1 for row in messages if row.get("role") in ("visitor", "customer", "user")),
            "source_created_at": persisted.get("updated_at"),
            "next_memory_revision": persisted.get("revision"),
        }
        with tempfile.TemporaryDirectory(prefix="c3-rebuild-") as temp:
            input_path = Path(temp) / "input.json"
            script_path = Path(temp) / "rebuild.ts"
            input_path.write_text(json.dumps(payload, ensure_ascii=False))
            module_uri = Path("supabase/functions/_shared/conversation-long-memory.ts").resolve().as_uri()
            script_path.write_text(f'import {{ buildCanonicalConversationMemory }} from "{module_uri}"; const x=JSON.parse(await Deno.readTextFile(Deno.args[0])); console.log(JSON.stringify(buildCanonicalConversationMemory(x)));')
            rebuilt_process = subprocess.run(
                ["deno", "run", "--no-lock", "--allow-read", str(script_path), str(input_path)],
                check=True, capture_output=True, text=True,
            )
        rebuilt = json.loads(rebuilt_process.stdout)
        current = persisted.get("memory") or {}
        mapping = {
            "current_facts": "current_customer_facts",
            "latest_corrections": "latest_corrections",
            "entities": "active_entities",
            "cancellations": "cancelled_or_superseded",
            "transaction_state": "transaction_summary",
            "regions": "current_regions",
            "open_questions": "open_questions",
        }
        fields = {label: current.get(key) == rebuilt.get(key) for label, key in mapping.items()}
        return {
            "equal": all(fields.values()),
            "source": "authoritative_history_and_canonical_state",
            "fields": fields,
            "conversation_id": conversation_id,
            "persisted_revision": persisted.get("revision"),
            "rebuilt_revision": rebuilt.get("memory_revision"),
        }

    def live_readback(self):
        with tempfile.TemporaryDirectory(prefix="c3-live-") as temp:
            root = Path(temp)
            listed = subprocess.run(["supabase", "functions", "list", "--project-ref", PROJECT, "--output", "json"], check=True, capture_output=True, text=True)
            raw_rows = json.loads(listed.stdout)
            rows = raw_rows.get("functions", raw_rows) if isinstance(raw_rows, dict) else raw_rows
            if not isinstance(rows, list):
                raise RuntimeError("live_function_list_shape_invalid")
            output = []
            for name, (version, bundle) in LIVE_EXPECTED.items():
                work = root / name
                (work / "supabase").mkdir(parents=True)
                (work / "supabase" / "config.toml").write_text(f'project_id = "{PROJECT}"\n')
                subprocess.run(["supabase", "functions", "download", name, "--project-ref", PROJECT, "--use-api"], cwd=work, check=True, capture_output=True, text=True)
                meta = next((x for x in rows if (x.get("slug") or x.get("name")) == name), None)
                artifact_manifest = json.loads((self.artifact_root / name / "MANIFEST.json").read_text())
                expected = {x["path"]: x["sha256"] for x in artifact_manifest["files"]}
                source = work / "supabase" / "functions"
                actual = {p.relative_to(source).as_posix(): sha256_bytes(p.read_bytes()) for p in source.rglob("*") if p.is_file()}
                if expected != actual:
                    raise RuntimeError(f"live_source_artifact_parity_failed:{name}")
                output.append({
                    "function": name, "version": int(meta.get("version", -1)), "status": meta.get("status"),
                    "verify_jwt": meta.get("verify_jwt"), "import_map": meta.get("import_map") is True,
                    "bundle": meta.get("ezbr_sha256"), "source_manifest_sha256": sha256_bytes((self.artifact_root / name / "MANIFEST.json").read_bytes()),
                    "source_parity": int(meta.get("version", -1)) == version and meta.get("ezbr_sha256") == bundle,
                })
            return output

    def db_security_readback(self):
        query = """
        select
          exists(select 1 from supabase_migrations.schema_migrations where version='20260915091441') as c3_migration_applied,
          to_regclass('public.conversation_memory_state') is not null as memory_table_exists,
          to_regclass('public.conversation_memory_state_event') is not null as event_table_exists,
          coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.conversation_memory_state')),false) as memory_rls,
          coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.conversation_memory_state_event')),false) as event_rls,
          exists(select 1 from pg_policies where schemaname='public' and tablename='conversation_memory_state' and policyname='conversation_memory_state_select_staff' and qual like '%is_company_member%' and qual like '%company_id%') as staff_membership_policy,
          to_regprocedure('public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)') is not null as c3_rpc_exists,
          coalesce(has_function_privilege('service_role',to_regprocedure('public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)'),'EXECUTE'),false) as c3_service_role_execute,
          not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure('public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)') and a.grantee=0 and a.privilege_type='EXECUTE') as c3_public_denied,
          not coalesce(has_function_privilege('anon',to_regprocedure('public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)'),'EXECUTE'),true) as c3_anon_denied,
          not coalesce(has_function_privilege('authenticated',to_regprocedure('public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)'),'EXECUTE'),true) as c3_authenticated_denied,
          exists(select 1 from pg_trigger where tgname='c3_conversation_memory_lineage_before_write' and tgrelid=to_regclass('public.conversation_memory_state') and tgenabled<>'D') as lineage_trigger,
          exists(select 1 from pg_trigger where tgname='c3_enrich_handoff_from_memory_before_insert' and tgrelid=to_regclass('public.handoff_event') and tgenabled<>'D') as c3_handoff_trigger,
          to_regclass('public.handoff_event') is not null as handoff_event_exists,
          coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.handoff_event')),false) as handoff_event_rls,
          to_regprocedure('public.c2_commit_closure_tx(uuid,uuid,uuid,bigint,text,jsonb)') is not null as c2_rpc_exists,
          coalesce(has_function_privilege('service_role',to_regprocedure('public.c2_commit_closure_tx(uuid,uuid,uuid,bigint,text,jsonb)'),'EXECUTE'),false) as c2_service_role_execute,
          not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure('public.c2_commit_closure_tx(uuid,uuid,uuid,bigint,text,jsonb)') and a.grantee=0 and a.privilege_type='EXECUTE') as c2_public_denied,
          not coalesce(has_function_privilege('anon',to_regprocedure('public.c2_commit_closure_tx(uuid,uuid,uuid,bigint,text,jsonb)'),'EXECUTE'),true) as c2_anon_denied,
          not coalesce(has_function_privilege('authenticated',to_regprocedure('public.c2_commit_closure_tx(uuid,uuid,uuid,bigint,text,jsonb)'),'EXECUTE'),true) as c2_authenticated_denied,
          exists(select 1 from pg_trigger where tgname='c2_handoff_package_before_insert' and tgrelid=to_regclass('public.handoff_event') and tgenabled<>'D') as c2_handoff_trigger,
          to_regprocedure('public.c2_populate_handoff_package_tg()') is not null as c2_trigger_function_exists,
          not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=to_regprocedure('public.c2_populate_handoff_package_tg()') and a.grantee=0 and a.privilege_type='EXECUTE') as c2_trigger_public_denied,
          not coalesce(has_function_privilege('anon',to_regprocedure('public.c2_populate_handoff_package_tg()'),'EXECUTE'),true) as c2_trigger_anon_denied,
          not coalesce(has_function_privilege('authenticated',to_regprocedure('public.c2_populate_handoff_package_tg()'),'EXECUTE'),true) as c2_trigger_authenticated_denied,
          not coalesce(has_function_privilege('service_role',to_regprocedure('public.c2_populate_handoff_package_tg()'),'EXECUTE'),true) as c2_trigger_service_role_denied
        """
        status, payload = self.management(
            DB_READBACK_ENDPOINT.format(project=PROJECT), "POST", {"query": query, "read_only": True}
        )
        row = validate_db_security_response(status, payload)
        return {"pass": True, "source": "management_api_read_only_sql", "checks": row, "observed_at": utc_now()}

    def cleanup(self):
        result = cleanup_manifest(self.manifest_path, self.supabase_url, self.server_key, self.access_token)
        self.manifest = json.loads(self.manifest_path.read_text())
        return result

    def validate(self):
        self.out.mkdir(parents=True, exist_ok=True)
        self.persist_manifest()
        self.load_keys()
        self.authenticate_staff()
        evidence = {
            "schema_version": SCHEMA, "mode": "live_production", "repository": REPOSITORY, "project": PROJECT,
            "run": {"id": os.environ.get("GITHUB_RUN_ID"), "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "started_at": self.started_at},
            "runner": {"head": os.environ["C3_EXPECTED_HEAD"], "tree": os.environ["C3_EXPECTED_TREE"]},
            "scenario_contract": {"version": CONTRACT_VERSION, "sha256": sha256_bytes(self.contract_raw)},
            "artifact": {"id": int(os.environ["C3_ARTIFACT_ID"]), "digest": os.environ["C3_ARTIFACT_DIGEST"]},
            "live_functions": [], "db_security": None, "scenarios": [], "quick_gate": {"all_pass": False, "long_run_started_only_after_pass": False},
            "historical_hkd_8000": {"pass": False, "source": "not_run"}, "core_checks": [],
            "long_run": None, "rebuild_comparison": None, "cleanup": None, "created_at": utc_now(),
        }
        failure = None
        try:
            evidence["live_functions"] = self.live_readback()
            evidence["db_security"] = self.db_security_readback()
            for row in self.contract["scenarios"]:
                evidence["scenarios"].append(self.scenario(row))
            # The evidence verifier, not this runner, computes semantic PASS from actual text.
            quick_file = self.out / "quick-evidence.json"
            write_json(quick_file, {**evidence, "mode": "nonproduction_quick_staging"})
            verifier = subprocess.run([
                "node", ".github/scripts/c3_validation_evidence.mjs", "verify", "--evidence", str(quick_file),
                "--contract", str(self.contract_path), "--expected-head", evidence["runner"]["head"],
                "--expected-tree", evidence["runner"]["tree"], "--expected-project", PROJECT,
                "--expected-run-id", str(evidence["run"]["id"]), "--expected-attempt", str(evidence["run"]["attempt"]),
                "--allow-synthetic", "true",
            ], capture_output=True, text=True)
            if verifier.returncode != 0:
                raise RuntimeError("quick_semantic_gate_failed:" + verifier.stderr.strip())
            evidence["historical_hkd_8000"] = self.historical_hkd_8000_probe()
            if evidence["historical_hkd_8000"]["pass"] is not True:
                raise RuntimeError("historical_hkd_8000_probe_failed")
            evidence["core_checks"] = self.core_smoke(evidence["scenarios"])
            missing_core = [row["name"] for row in evidence["core_checks"] if row["pass"] is not True]
            if missing_core:
                raise RuntimeError("core_runtime_observability_or_behavior_failed:" + ",".join(missing_core))
            evidence["quick_gate"] = {"all_pass": True, "long_run_started_only_after_pass": True}
            evidence["long_run"] = self.long_run()
            evidence["rebuild_comparison"] = self.rebuild_comparison(evidence["long_run"]["conversation_id"])
        except Exception as error:
            failure = str(error)
            evidence["failure_reason"] = failure
        finally:
            try:
                evidence["cleanup"] = self.cleanup()
            except Exception as cleanup_error:
                evidence["cleanup"] = {"completed": False, "failure": str(cleanup_error), "source": "exact_fixture_manifest"}
                failure = failure or f"cleanup_failed:{cleanup_error}"
            evidence["created_at"] = utc_now()
            write_json(self.evidence_path, evidence)
        if failure:
            raise RuntimeError(failure)


def cleanup_manifest(manifest_path: Path, supabase_url: str, server_key: str, access_token: str):
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("project") != PROJECT or manifest.get("exclude_training") is not True:
        raise RuntimeError("cleanup_manifest_identity_invalid")
    ids = [x["conversation_id"] for x in manifest.get("conversations", [])]
    if len(ids) != len(set(ids)):
        raise RuntimeError("cleanup_manifest_duplicate_conversation")
    session_ids = [x.get("visitor_session_id") for x in manifest.get("conversations", []) if x.get("visitor_session_id")]
    if len(session_ids) != len(set(session_ids)):
        raise RuntimeError("cleanup_manifest_duplicate_visitor_session")
    try:
        ids = [str(uuid.UUID(value)) for value in ids]
        session_ids = [str(uuid.UUID(value)) for value in session_ids]
    except (ValueError, TypeError, AttributeError) as error:
        raise RuntimeError("cleanup_manifest_non_uuid_identity") from error
    if not access_token:
        raise RuntimeError("credential_missing:SUPABASE_ACCESS_TOKEN")

    if not ids and not session_ids:
        readback = {
            "safely_deletable_residue": 0,
            "active_conversations": 0,
            "active_jobs": 0,
            "retained_audit_count": 0,
            "training_eligible": 0,
            "learning_candidates": 0,
        }
        attempt = {
            "at": utc_now(), "exact_conversation_ids": [], "exact_visitor_session_ids": [],
            "readback": readback, "result": "completed_no_owned_fixtures",
        }
        manifest.setdefault("cleanup_attempts", []).append(attempt)
        manifest["cleanup_completed"] = True
        write_json(manifest_path, manifest)
        return {
            "completed": True, "source": "exact_fixture_manifest",
            "fixture_manifest_sha256": sha256_bytes(manifest_path.read_bytes()),
            "readback_source": "empty_exact_manifest_no_production_delete",
            "fixture_state": "no_owned_fixtures", "exclude_training": True, **readback,
        }

    # The state/event tables deliberately grant service_role SELECT only. Cleanup therefore
    # uses the authenticated Management API SQL endpoint, inside one exact-ID transaction.
    # Training-eligible/candidate/outbox records abort before the first DELETE. Ordinary CE
    # rows created automatically for exclude_training fixtures are exact-ID cleanup targets.
    conv_values = ",".join(f"('{value}'::uuid)" for value in ids) or "(null::uuid)"
    session_values = ",".join(f"('{value}'::uuid)" for value in session_ids) or "(null::uuid)"
    sql = f"""
    begin;
    do $cleanup_guard$
    begin
      if exists (
        with target(id) as (values {conv_values})
        select 1 from public.conversation_evaluation e join target t on t.id=e.conversation_id
        where e.training_eligible
      ) then raise exception 'c3_cleanup_training_eligible_detected'; end if;
      if exists (
        with target(id) as (values {conv_values})
        select 1 from public.hf3_learning_case l join target t on t.id=l.conversation_id
        where l.training_candidate
      ) then raise exception 'c3_cleanup_learning_candidate_detected'; end if;
      if exists (
        with target(id) as (values {conv_values})
        select 1 from public.evaluation_training_outbox o
        join public.conversation_evaluation e on e.id=o.evaluation_id
        join target t on t.id=e.conversation_id
      ) then raise exception 'c3_cleanup_training_outbox_detected'; end if;
    end $cleanup_guard$;
    with target(id) as (values {conv_values})
      delete from public.hf3_learning_case l using target t where l.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.conversation_evaluation e using target t where e.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.conversation_evaluation_attempt a using target t where a.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.ce_evaluation_job j using target t where j.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.conversation_memory_state_event e using target t where e.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.conversation_commerce_state_event e using target t where e.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.conversation_memory_state s using target t where s.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.conversation_commerce_state s using target t where s.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.handoff_event h using target t where h.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.messages m using target t where m.conversation_id=t.id;
    with target(id) as (values {conv_values})
      delete from public.conversations c using target t where c.id=t.id;
    with target(id) as (values {session_values})
      delete from public.widget_session_event w using target t where w.visitor_session_id=t.id;
    with target(id) as (values {session_values})
      delete from public.visitor_session s using target t where s.id=t.id;
    commit;
    with conversation_target(id) as (values {conv_values}),
         session_target(id) as (values {session_values})
    select
      (select count(*)::int from public.conversations c join conversation_target t on t.id=c.id) as active_conversations,
      (select count(*)::int from public.ce_evaluation_job j join conversation_target t on t.id=j.conversation_id) as active_jobs,
      (select count(*)::int from public.conversation_evaluation e join conversation_target t on t.id=e.conversation_id where e.training_eligible) as training_eligible,
      (select count(*)::int from public.hf3_learning_case l join conversation_target t on t.id=l.conversation_id where l.training_candidate) as learning_candidates,
      (select count(*)::int from public.audit_log a join conversation_target t on a.resource_id=t.id) as retained_audit_count,
      ((select count(*) from public.messages m join conversation_target t on t.id=m.conversation_id) +
       (select count(*) from public.handoff_event h join conversation_target t on t.id=h.conversation_id) +
       (select count(*) from public.conversation_memory_state s join conversation_target t on t.id=s.conversation_id) +
       (select count(*) from public.conversation_memory_state_event e join conversation_target t on t.id=e.conversation_id) +
       (select count(*) from public.conversation_commerce_state s join conversation_target t on t.id=s.conversation_id) +
       (select count(*) from public.conversation_commerce_state_event e join conversation_target t on t.id=e.conversation_id) +
       (select count(*) from public.widget_session_event w join session_target t on t.id=w.visitor_session_id) +
       (select count(*) from public.visitor_session s join session_target t on t.id=s.id))::int as safely_deletable_residue;
    """
    status, payload = request(
        f"https://api.supabase.com/v1/projects/{PROJECT}/database/query", "POST", {"query": sql},
        {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
    )
    if status not in DB_READBACK_SUCCESS_STATUSES or not isinstance(payload, list) or len(payload) != 1:
        raise RuntimeError(f"cleanup_transaction_or_readback_failed:http_{status}")
    readback = payload[0]
    required_counts = ["safely_deletable_residue", "active_conversations", "active_jobs", "retained_audit_count", "training_eligible", "learning_candidates"]
    if any(not isinstance(readback.get(key), int) for key in required_counts):
        raise RuntimeError("cleanup_readback_shape_invalid")
    if any(readback[key] != 0 for key in ["safely_deletable_residue", "active_conversations", "active_jobs", "training_eligible", "learning_candidates"]):
        raise RuntimeError("cleanup_readback_nonzero:" + json.dumps(readback, sort_keys=True))
    attempt = {"at": utc_now(), "exact_conversation_ids": ids, "exact_visitor_session_ids": session_ids, "readback": readback, "result": "completed"}
    manifest.setdefault("cleanup_attempts", []).append(attempt)
    manifest["cleanup_completed"] = True
    write_json(manifest_path, manifest)
    digest = sha256_bytes(manifest_path.read_bytes())
    return {
        "completed": True, "source": "exact_fixture_manifest", "fixture_manifest_sha256": digest,
        "readback_source": "management_api_exact_id_transaction_and_post_delete_select",
        "fixture_state": "inactive_deleted", "exclude_training": True,
        **readback,
    }


def run_db_readback_contract_tests() -> None:
    valid = {name: True for name in DB_SECURITY_ASSERTIONS}

    def expect_pass(name: str, status: int, payload: object) -> None:
        telemetry = []
        assert validate_db_security_response(status, payload, telemetry.append) == valid
        assert any(
            line == f"C3_DB_READBACK|endpoint={DB_READBACK_SAFE_NAME}|method=POST|status={status}|result=PASS"
            for line in telemetry
        )
        assert sum(line.startswith("C3_DB_ASSERT|") for line in telemetry) == len(DB_SECURITY_ASSERTIONS)
        print(f"C3_DB_CONTRACT_TEST|name={name}|result=PASS")

    def expect_fail(name: str, status: int, payload: object, reason: str) -> None:
        try:
            validate_db_security_response(status, payload, lambda _line: None)
        except RuntimeError as error:
            assert reason in str(error), (name, error)
        else:
            raise AssertionError(f"{name}:expected_failure")
        print(f"C3_DB_CONTRACT_TEST|name={name}|result=PASS")

    expect_pass("valid_200_valid_body", 200, [valid])
    expect_pass("valid_201_valid_body", 201, [valid])
    expect_fail("allowed_status_malformed_body", 201, {"result": valid}, "invalid_payload")
    missing = dict(valid)
    missing.pop("c3_migration_applied")
    expect_fail("allowed_status_missing_required_rows", 201, [missing], "invalid_payload")
    for status in (401, 403, 404, 500):
        expect_fail(f"http_{status}", status, [valid], f"http_{status}")
    rls_disabled = dict(valid)
    rls_disabled["memory_rls"] = False
    expect_fail("rls_disabled", 201, [rls_disabled], "memory_rls")
    rpc_grant = dict(valid)
    rpc_grant["c3_service_role_execute"] = False
    expect_fail("rpc_grant_mismatch", 201, [rpc_grant], "c3_service_role_execute")
    c2_drift = dict(valid)
    c2_drift["c2_handoff_trigger"] = False
    expect_fail("c2_boundary_drift", 201, [c2_drift], "c2_handoff_trigger")
    print("C3_DB_READBACK_CONTRACT_TESTS=PASS")


def run_runtime_wait_contract_tests() -> None:
    base = dict(allow_human_suppression=False, customer_persisted=True,
                new_assistant_count=0, handoff_present=False,
                receive_control_state="ai", receive_ai_reply_pending=True,
                conversation_status="open", resolved_at=None, deadline_expired=False)

    def check(name: str, expected: str, **changes) -> None:
        actual = classify_runtime_wait(**{**base, **changes})
        assert actual == expected, (name, expected, actual)
        print(f"C3_RUNTIME_WAIT_CONTRACT|name={name}|expected={expected}|actual={actual}|result=PASS")

    check("quick_normal_reply", "assistant_persisted", new_assistant_count=1)
    check("expected_human_control_suppression", "expected_human_control_suppression",
          allow_human_suppression=True, handoff_present=True, conversation_status="pending",
          receive_control_state="human_control", receive_ai_reply_pending=False)
    check("delayed_reply_within_budget_initial_wait", "continue_waiting")
    check("delayed_reply_within_budget_terminal", "assistant_persisted", new_assistant_count=1)
    check("never_arrives_timeout", "assistant_response_timeout", deadline_expired=True)
    check("late_after_runner_deadline", "assistant_persisted_after_deadline",
          new_assistant_count=1, deadline_expired=True)
    check("poll_error_then_recovery_initial_wait", "continue_waiting")
    check("poll_error_then_recovery_terminal", "assistant_persisted", new_assistant_count=1)
    check("duplicate_response", "duplicate_assistant_response", new_assistant_count=2)
    check("customer_not_persisted", "customer_persistence_timeout",
          customer_persisted=False, deadline_expired=True)
    check("suppression_missing_handoff", "assistant_response_timeout",
          allow_human_suppression=True, conversation_status="pending", deadline_expired=True,
          receive_control_state="human_control", receive_ai_reply_pending=False)
    check("suppression_resolved_is_invalid", "assistant_response_timeout",
          allow_human_suppression=True, handoff_present=True, conversation_status="pending",
          receive_control_state="human_control", receive_ai_reply_pending=False,
          resolved_at="2026-09-16T00:00:00Z", deadline_expired=True)
    check("suppression_receive_contract_mismatch", "assistant_response_timeout",
          allow_human_suppression=True, handoff_present=True, conversation_status="pending",
          deadline_expired=True)
    print("C3_RUNTIME_WAIT_CONTRACT_TESTS=PASS")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "cleanup", "db-readback", "db-contract-test", "runtime-contract-test"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--artifact-root")
    parser.add_argument("--manifest")
    parser.add_argument("--marker")
    args = parser.parse_args()
    out = Path(args.out).resolve()
    if args.command == "db-contract-test":
        run_db_readback_contract_tests()
        return
    if args.command == "runtime-contract-test":
        run_runtime_wait_contract_tests()
        return
    if args.command == "db-readback":
        harness = Harness(out, Path(args.contract).resolve(), Path(args.artifact_root or ".").resolve())
        result = harness.db_security_readback()
        write_json(out / "db-security-evidence.json", result)
        print("C3_DB_SECURITY_READBACK_PREFLIGHT=PASS")
        return
    if args.command == "cleanup":
        key = os.environ.get("C3_SERVER_KEY", "")
        if not key:
            raise SystemExit("credential_missing:C3_SERVER_KEY")
        manifest_path = Path(args.manifest).resolve()
        if not manifest_path.is_file():
            if not args.marker:
                raise SystemExit("fixture_manifest_missing_and_marker_not_provided")
            headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            base = os.environ.get("VITE_SUPABASE_URL", f"https://{PROJECT}.supabase.co")
            query = urllib.parse.urlencode({"visitor_metadata->>c3_validation_marker": f"eq.{args.marker}", "select": "id"})
            status, sessions = request(f"{base}/rest/v1/visitor_session?{query}", headers=headers)
            if status != 200 or not isinstance(sessions, list):
                raise SystemExit("durable_marker_session_recovery_failed")
            conversations = []
            for session in sessions:
                q = urllib.parse.urlencode({"visitor_session_id": f"eq.{session['id']}", "select": "id"})
                st, rows = request(f"{base}/rest/v1/conversations?{q}", headers=headers)
                if st != 200: raise SystemExit("durable_marker_conversation_recovery_failed")
                conversations.extend({"conversation_id": row["id"], "visitor_session_id": session["id"]} for row in rows)
            recovered = {"schema_version":"ai-abc-c3-fixture-manifest-1.0.0","project":PROJECT,"marker":args.marker,"exclude_training":True,"conversations":conversations,"cleanup_attempts":[],"recovered_from":"exact_durable_visitor_session_marker"}
            write_json(manifest_path, recovered)
        result = cleanup_manifest(
            manifest_path,
            os.environ.get("VITE_SUPABASE_URL", f"https://{PROJECT}.supabase.co"),
            key,
            os.environ.get("SUPABASE_ACCESS_TOKEN", ""),
        )
        write_json(out / "cleanup-evidence.json", result)
        print("C3_CLEANUP_ONLY|result=PASS")
        return
    if not args.artifact_root:
        raise SystemExit("--artifact-root required for validate")
    Harness(out, Path(args.contract).resolve(), Path(args.artifact_root).resolve()).validate()
    print("C3_VALIDATION_ONLY_RUNNER|result=PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"C3_VALIDATION_ONLY_RUNNER|result=FAIL|reason={error}", file=sys.stderr)
        raise
