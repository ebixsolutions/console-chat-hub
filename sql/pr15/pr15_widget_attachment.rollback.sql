BEGIN;
DROP FUNCTION IF EXISTS public.receive_widget_attachment_tx(uuid,text,text,text,text,text,bigint);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id='widget-attachments') THEN
    RAISE EXCEPTION 'rollback_blocked_widget_attachments_not_empty';
  END IF;
  DELETE FROM storage.buckets WHERE id='widget-attachments';
END $$;

COMMIT;
