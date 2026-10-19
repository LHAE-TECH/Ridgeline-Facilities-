-- Unfunded / over-authority P1 jobs are dispatched for MAKE-SAFE scope only, up to a cap.
ALTER TABLE customers ADD COLUMN p1_unfunded_cap_ex_gst_cents BIGINT CHECK (p1_unfunded_cap_ex_gst_cents >= 0);           -- NULL = global setting
ALTER TABLE customers ADD COLUMN p1_unfunded_suspend_threshold_cents BIGINT CHECK (p1_unfunded_suspend_threshold_cents >= 0); -- NULL = global setting

ALTER TABLE jobs ADD COLUMN p1_scope TEXT CHECK (p1_scope IN ('make_safe'));
ALTER TABLE jobs ADD COLUMN p1_scope_reason TEXT CHECK (p1_scope_reason IN ('unfunded', 'over_authority', 'unfunded_over_authority'));
ALTER TABLE jobs ADD COLUMN p1_scope_cap_ex_gst_cents BIGINT;
-- Part of the committed amount not covered by available prepaid funds when the job was released.
ALTER TABLE jobs ADD COLUMN unfunded_cents BIGINT NOT NULL DEFAULT 0 CHECK (unfunded_cents >= 0);
ALTER TABLE jobs ADD COLUMN scope_extended_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN scope_extended_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN scope_extension_kind TEXT CHECK (scope_extension_kind IN ('customer_approval', 'staff_override'));
ALTER TABLE jobs ADD COLUMN scope_extension_reason TEXT;
ALTER TABLE jobs ADD CONSTRAINT jobs_scope_extension_recorded
  CHECK (scope_extended_at IS NULL OR (scope_extended_by IS NOT NULL AND scope_extension_kind IS NOT NULL AND scope_extension_reason IS NOT NULL));

-- Resolved SLA area cached on the site (refreshed when the site, a pin or the sla_areas setting changes) so booking
-- checks and reporting can see whether the area is confirmed.
ALTER TABLE sites ADD COLUMN sla_area TEXT;
ALTER TABLE sites ADD COLUMN sla_area_source TEXT NOT NULL DEFAULT 'unconfirmed'
  CHECK (sla_area_source IN ('override', 'suburb', 'city', 'unconfirmed'));
