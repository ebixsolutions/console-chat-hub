-- Only AFTER Work fresh metadata/config/logs/baseline and remaining allowance=1.
-- No body, key, job, target or TTL override. Activation lasts five minutes.
update c3_b12_once.ledger
set armed=true, guards_reviewed_at=now(), expires_at=least(expires_at,now()+interval '5 minutes')
where operation='C3-B12-WORKER-ONCE-20261009-42eee3e7'
  and spent_at is null and not armed and expires_at>now()
returning operation,armed,guards_reviewed_at,expires_at;
