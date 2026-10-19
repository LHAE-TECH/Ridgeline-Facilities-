-- Evidence integrity: once recorded, evidence and completion reports cannot be altered.
-- Evidence may only be withdrawn (with reason); completion reports may only receive their review decision.

CREATE FUNCTION guard_job_evidence_update() RETURNS trigger AS $$
BEGIN
  IF (NEW.job_id, NEW.kind, NEW.file_id, NEW.caption, NEW.device_captured_at, NEW.lat, NEW.lng, NEW.uploaded_by, NEW.uploaded_at)
     IS DISTINCT FROM (OLD.job_id, OLD.kind, OLD.file_id, OLD.caption, OLD.device_captured_at, OLD.lat, OLD.lng, OLD.uploaded_by, OLD.uploaded_at) THEN
    RAISE EXCEPTION 'job_evidence is immutable except for withdrawal';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'withdrawn evidence cannot be changed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER job_evidence_guard BEFORE UPDATE ON job_evidence FOR EACH ROW EXECUTE FUNCTION guard_job_evidence_update();

CREATE FUNCTION guard_completion_report_update() RETURNS trigger AS $$
BEGIN
  IF (NEW.job_id, NEW.version, NEW.work_performed, NEW.labour_minutes, NEW.workers, NEW.materials, NEW.site_notes, NEW.issues_found,
      NEW.acknowledged_by_name, NEW.acknowledged_at, NEW.submitted_by, NEW.submitted_at, NEW.review_flags)
     IS DISTINCT FROM (OLD.job_id, OLD.version, OLD.work_performed, OLD.labour_minutes, OLD.workers, OLD.materials, OLD.site_notes, OLD.issues_found,
      OLD.acknowledged_by_name, OLD.acknowledged_at, OLD.submitted_by, OLD.submitted_at, OLD.review_flags) THEN
    RAISE EXCEPTION 'completion reports are immutable; submit a new version instead';
  END IF;
  IF OLD.review_status <> 'pending' THEN
    RAISE EXCEPTION 'a reviewed completion report cannot be changed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER completion_report_guard BEFORE UPDATE ON completion_reports FOR EACH ROW EXECUTE FUNCTION guard_completion_report_update();
