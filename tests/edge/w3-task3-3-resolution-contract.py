#!/usr/bin/env python3
"""Task 3.3 resolution RPC closure contract."""
from pathlib import Path
import sys

r = Path(sys.argv[1] if len(sys.argv) > 1 else '.')

def read(path: str) -> str:
    p = r / path
    assert p.is_file() and p.stat().st_size > 0, f"missing/empty {path}"
    return p.read_text()

sql = read('sql/pr30/pr30_conversation_resolution_tx.sql')
rollback = read('sql/pr30/pr30_conversation_resolution_tx.rollback.sql')
resolve = read('supabase/functions/resolve-conversation/index.ts')
unresolved = read('supabase/functions/mark-unresolved/index.ts')

for src_name, src, target in [
    ('resolve-conversation', resolve, 'resolved'),
    ('mark-unresolved', unresolved, 'unresolved'),
]:
    assert 'set_conversation_resolution_tx' in src, f'{src_name} missing canonical RPC'
    assert f'p_target_state: "{target}"' in src, f'{src_name} wrong target state'
    for marker in ['p_company_id: scope.companyId', 'p_actor_user_id: agent.user_id', 'p_actor_agent_id: agent.id']:
        assert marker in src, f'{src_name} missing server-derived scope: {marker}'

for marker in [
    'BEGIN;',
    'CREATE OR REPLACE FUNCTION public.set_conversation_resolution_tx',
    "p_target_state NOT IN ('resolved', 'unresolved')",
    'FROM public.agent_profile',
    'JOIN public.company co',
    'FROM public.company_membership cm',
    'cm.user_id = p_actor_user_id',
    'cm.company_id = p_company_id',
    'cm.is_active = true',
    'FOR UPDATE',
    'v_conv.company_id IS DISTINCT FROM p_company_id',
    "COALESCE(v_role, '') NOT IN ('admin', 'supervisor')",
    'v_conv.assigned_agent_id IS DISTINCT FROM p_actor_agent_id',
    'INSERT INTO public.conversation_status_log',
    'INSERT INTO public.audit_log',
    'REVOKE ALL ON FUNCTION public.set_conversation_resolution_tx',
    'GRANT EXECUTE ON FUNCTION public.set_conversation_resolution_tx',
    'TO service_role;',
    'COMMIT;',
]:
    assert marker in sql, f'resolution SQL missing: {marker}'

assert 'DROP FUNCTION IF EXISTS public.set_conversation_resolution_tx' in rollback
assert 'authenticated cannot invoke set_conversation_resolution_tx' in sql
assert 'service_role execute missing' in sql

print('PASS Task 3.3 conversation resolution RPC contract')
