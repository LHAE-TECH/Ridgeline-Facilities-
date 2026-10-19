-- Agreement acceptance history: every acceptance of every version, never overwritten.
CREATE TABLE agreement_acceptances (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL CHECK (kind IN ('customer', 'contractor')),
  version        TEXT NOT NULL,
  customer_id    UUID REFERENCES customers(id),
  contractor_id  UUID REFERENCES contractors(id),
  accepted_by    UUID REFERENCES users(id),
  accepted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip             TEXT,
  source         TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'registration', 'backfill')),
  CHECK ((kind = 'customer') = (customer_id IS NOT NULL)),
  CHECK ((kind = 'contractor') = (contractor_id IS NOT NULL))
);
CREATE INDEX agreement_acceptances_customer ON agreement_acceptances (customer_id, accepted_at);
CREATE INDEX agreement_acceptances_contractor ON agreement_acceptances (contractor_id, accepted_at);
CREATE TRIGGER agreement_acceptances_append_only BEFORE UPDATE OR DELETE ON agreement_acceptances
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE contractors ADD COLUMN agreement_accepted_by UUID REFERENCES users(id);

INSERT INTO agreement_acceptances (kind, version, customer_id, accepted_by, accepted_at, source)
  SELECT 'customer', terms_version, id, terms_accepted_by, terms_accepted_at, 'backfill' FROM customers WHERE terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL;
INSERT INTO agreement_acceptances (kind, version, contractor_id, accepted_at, source)
  SELECT 'contractor', agreement_version, id, agreement_accepted_at, 'backfill' FROM contractors WHERE agreement_version IS NOT NULL AND agreement_accepted_at IS NOT NULL;

-- Follow-up ageing, customer communication and decisions. Suggestions are never deleted.
ALTER TABLE follow_up_suggestions DROP CONSTRAINT follow_up_suggestions_status_check;
ALTER TABLE follow_up_suggestions ADD CONSTRAINT follow_up_suggestions_status_check
  CHECK (status IN ('open', 'booked', 'dismissed', 'declined_by_customer'));
ALTER TABLE follow_up_suggestions ADD CONSTRAINT follow_up_declined_reason
  CHECK (status <> 'declined_by_customer' OR (decision_note IS NOT NULL AND decided_by IS NOT NULL));
ALTER TABLE follow_up_suggestions ADD COLUMN decided_on_behalf_of_customer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE follow_up_suggestions ADD COLUMN customer_notified_at TIMESTAMPTZ;
ALTER TABLE follow_up_suggestions ADD COLUMN flagged_at TIMESTAMPTZ;
ALTER TABLE follow_up_suggestions ADD COLUMN escalated_at TIMESTAMPTZ;
ALTER TABLE follow_up_suggestions ADD COLUMN customer_reminded_at TIMESTAMPTZ;
CREATE TRIGGER follow_up_suggestions_no_delete BEFORE DELETE ON follow_up_suggestions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
