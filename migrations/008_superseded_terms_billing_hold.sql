-- Staff may book for a customer on superseded material terms (an emergency is never stopped by paperwork); the job is
-- tagged and its customer invoice is held for review until the customer accepts or finance issues it with a reason.
ALTER TABLE jobs ADD COLUMN terms_version_at_booking TEXT;
ALTER TABLE jobs ADD COLUMN booked_under_superseded_terms BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customer_invoices ADD COLUMN superseded_terms_issue_reason TEXT;
ALTER TABLE customer_invoices ADD COLUMN superseded_terms_issued_by UUID REFERENCES users(id);
ALTER TABLE customer_invoices ADD CONSTRAINT customer_invoices_superseded_reason_recorded
  CHECK (superseded_terms_issue_reason IS NULL OR superseded_terms_issued_by IS NOT NULL);
