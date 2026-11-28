-- Only non-secret operations evidence. No Vault/runtime hash/private headers.
select operation,armed,created_at,expires_at,guards_reviewed_at,spent_at,receipt
from c3_b12_once.ledger
where operation='C3-B12-WORKER-ONCE-20261009-42eee3e7';
