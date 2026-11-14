CREATE OR REPLACE FUNCTION public.ce_conversation_evaluable_v1(p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE WHEN public.c3_uat_learning_excluded(p_conversation_id) OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = p_conversation_id AND COALESCE(c.metadata_source->>'source','') = 'widget_live_test' AND COALESCE((c.metadata_source->>'widget_live_test')::boolean,false) = true AND COALESCE((c.metadata_source->>'exclude_training')::boolean,false) = true) THEN false ELSE (count(*) FILTER (WHERE NOT COALESCE(m.is_recalled,false) AND lower(m.role) IN ('visitor','customer','user')) > 0 AND count(*) FILTER (WHERE NOT COALESCE(m.is_recalled,false) AND lower(m.role) IN ('assistant','ai','bot')) > 0) END FROM public.messages m WHERE m.conversation_id = p_conversation_id AND COALESCE(m.content,'') IS DISTINCT FROM '__THINKING__'
$function$;
