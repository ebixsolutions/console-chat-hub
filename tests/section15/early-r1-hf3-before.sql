CREATE OR REPLACE FUNCTION public.hf3_handoff_refresh_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_eval_id uuid;
BEGIN
  SELECT e.id INTO v_eval_id
    FROM public.conversation_evaluation e
   WHERE e.conversation_id = NEW.conversation_id
     AND e.freshness = 'current'
   ORDER BY e.created_at DESC
   LIMIT 1;
  IF v_eval_id IS NOT NULL THEN
    PERFORM public.hf3_refresh_learning_case_tx(v_eval_id);
  END IF;
  RETURN NEW;
END;
$function$
;
