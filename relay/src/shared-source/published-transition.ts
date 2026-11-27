// Each operation can only reference its own transition tables. DELETE uses the full capture path.
export const SKIP_UNPUBLISHED_STATEMENT = `IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM capture_new WHERE effect_status IN ('none','completed')) THEN RETURN NULL; END IF;
   ELSIF TG_OP='UPDATE' THEN
    IF NOT EXISTS(SELECT 1 FROM capture_old WHERE effect_status IN ('none','completed'))
     AND NOT EXISTS(SELECT 1 FROM capture_new WHERE effect_status IN ('none','completed')) THEN RETURN NULL; END IF;
   END IF;`
