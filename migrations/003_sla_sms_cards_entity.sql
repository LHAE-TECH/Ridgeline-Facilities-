-- Round 2: published SLA priority matrix, SMS dispatch, saved-card auto top-ups, legal entity.

-- ---------------------------------------------------------------------------
-- Priority matrix: P1 emergency, P2 urgent, P3 standard, P4 scheduled.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs DROP CONSTRAINT jobs_priority_check;
UPDATE jobs SET priority = 'standard' WHERE priority = 'routine';
ALTER TABLE jobs ADD CONSTRAINT jobs_priority_check CHECK (priority IN ('emergency','urgent','standard','scheduled'));

ALTER TABLE pricing_rules DROP CONSTRAINT pricing_rules_priority_check;
UPDATE pricing_rules SET priority = 'standard' WHERE priority = 'routine';
ALTER TABLE pricing_rules ADD CONSTRAINT pricing_rules_priority_check CHECK (priority IN ('emergency','urgent','standard','scheduled'));

-- Stored setting overrides keyed by the old priority name.
UPDATE settings SET value = (value - 'routine') || jsonb_build_object('standard', value->'routine')
 WHERE key = 'offer_expiry_minutes' AND value ? 'routine';
DELETE FROM settings WHERE key = 'sla_hours';

-- Metro classification drives the P1 target (non-metro P1 has its own configurable target).
ALTER TABLE sites ADD COLUMN is_metro BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE jobs
  ADD COLUMN triage JSONB,
  ADD COLUMN suggested_priority TEXT,
  ADD COLUMN priority_note TEXT,
  ADD COLUMN sla_started_at TIMESTAMPTZ,
  ADD COLUMN sla_onsite_due TIMESTAMPTZ,
  ADD COLUMN sla_resolve_due TIMESTAMPTZ,
  ADD COLUMN sla_targets JSONB,
  ADD COLUMN sla_onsite_met BOOLEAN,
  ADD COLUMN sla_resolve_met BOOLEAN,
  ADD COLUMN sla_onsite_breached_at TIMESTAMPTZ,
  ADD COLUMN sla_resolve_breached_at TIMESTAMPTZ,
  ADD COLUMN sla_at_risk_alerted_at TIMESTAMPTZ,
  ADD COLUMN made_safe_at TIMESTAMPTZ,
  ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN escalated_at TIMESTAMPTZ,
  ADD COLUMN dispatch_wave INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN dispatch_wave_at TIMESTAMPTZ;
CREATE INDEX jobs_sla_open_idx ON jobs(sla_onsite_due) WHERE status IN ('dispatch','offered','assigned');

ALTER TABLE job_offers
  ADD COLUMN wave INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN rank INTEGER,
  ADD COLUMN est_arrival_minutes INTEGER,
  ADD COLUMN can_meet_sla BOOLEAN;

-- ---------------------------------------------------------------------------
-- SMS
-- ---------------------------------------------------------------------------
ALTER TABLE contractors ADD COLUMN mobile_phone TEXT CHECK (mobile_phone IS NULL OR mobile_phone ~ '^\+64[0-9]{8,10}$');
ALTER TABLE notifications
  ADD COLUMN recipient_phone TEXT,
  ADD COLUMN delivery_status TEXT,
  ADD COLUMN delivery_updated_at TIMESTAMPTZ;
CREATE INDEX notifications_provider_msg_idx ON notifications(provider_message_id);

-- ---------------------------------------------------------------------------
-- Saved cards for consented automatic top-ups (Stripe off-session charges)
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN stripe_customer_id TEXT UNIQUE;

CREATE TABLE customer_payment_methods (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customers(id),
  provider          TEXT NOT NULL DEFAULT 'stripe',
  provider_pm_id    TEXT NOT NULL UNIQUE,
  provider_setup_id TEXT UNIQUE,
  brand             TEXT,
  last4             TEXT,
  exp_month         INTEGER,
  exp_year          INTEGER,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','replaced','removed')),
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX customer_payment_methods_one_active_idx ON customer_payment_methods(customer_id) WHERE status = 'active';

ALTER TABLE auto_topup_consents
  ADD COLUMN payment_method_id UUID REFERENCES customer_payment_methods(id),
  ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_attempt_at TIMESTAMPTZ,
  ADD COLUMN last_failure_reason TEXT;

ALTER TABLE customer_payments ADD COLUMN failure_code TEXT;

-- ---------------------------------------------------------------------------
-- Legal entity: LHA Holdings Limited trading as Ridgeline Facilities
-- ---------------------------------------------------------------------------
UPDATE settings SET value = value
    || jsonb_build_object('legal_name', 'LHA Holdings Limited', 'trading_name', 'Ridgeline Facilities', 'nzbn', '9429052390173')
    || CASE WHEN value->>'bank_account_name' = 'Ridgeline Facilities Limited' THEN jsonb_build_object('bank_account_name', 'LHA Holdings Limited') ELSE '{}'::jsonb END
 WHERE key = 'company';

ALTER TABLE customers ADD COLUMN terms_version TEXT, ADD COLUMN terms_accepted_at TIMESTAMPTZ, ADD COLUMN terms_accepted_by UUID REFERENCES users(id);
ALTER TABLE contractors ADD COLUMN agreement_version TEXT, ADD COLUMN agreement_accepted_at TIMESTAMPTZ;
