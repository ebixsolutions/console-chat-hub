-- Preserve ledger permanently, especially spent/unknown; never reset allowance.
update c3_b12_once.ledger set armed=false
where operation='C3-B12-WORKER-ONCE-20261009-42eee3e7'
returning operation,armed,spent_at;
