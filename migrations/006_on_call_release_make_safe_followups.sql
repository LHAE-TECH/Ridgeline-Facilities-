-- On-call P1 release: staff who receive the threshold-hold SMS can release a held P1 for make-safe scope.
ALTER TABLE users ADD COLUMN on_call_p1_release BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT users_on_call_staff_only CHECK (NOT on_call_p1_release OR role IN ('admin','ops','finance'));

ALTER TABLE funding_exceptions ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'on_call_make_safe'));

-- P1 held at the unfunded threshold. The SLA clock is never paused; the hold is recorded and reported separately.
ALTER TABLE jobs ADD COLUMN p1_held_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN p1_hold_released_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN p1_hold_released_by UUID REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN p1_hold_release_kind TEXT CHECK (p1_hold_release_kind IN ('on_call', 'funding_exception', 'funded', 'cancelled'));

-- Make-safe completion: what was made safe and what remains outstanding (both required on make-safe jobs).
ALTER TABLE completion_reports ADD COLUMN made_safe_summary TEXT;
ALTER TABLE completion_reports ADD COLUMN outstanding_work TEXT;

-- Outstanding work from a make-safe job becomes a follow-up suggestion that staff must book or dismiss with a reason.
CREATE TABLE follow_up_suggestions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           UUID NOT NULL REFERENCES jobs(id),
  customer_id      UUID NOT NULL REFERENCES customers(id),
  site_id          UUID NOT NULL REFERENCES sites(id),
  trade_id         INTEGER NOT NULL REFERENCES trades(id),
  completion_report_id UUID REFERENCES completion_reports(id),
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'booked', 'dismissed')),
  follow_up_job_id UUID REFERENCES jobs(id),
  decided_by       UUID REFERENCES users(id),
  decided_at       TIMESTAMPTZ,
  decision_note    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'dismissed' OR (decision_note IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (status <> 'booked' OR follow_up_job_id IS NOT NULL)
);
-- One live suggestion per job; a resubmitted completion report updates it.
CREATE UNIQUE INDEX follow_up_one_open_per_job ON follow_up_suggestions (job_id) WHERE status = 'open';
