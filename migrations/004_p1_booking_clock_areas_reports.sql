-- Round 3: P1 SLA clock starts at booking; Auckland SLA areas by suburb; monthly report opt-in per customer.

-- When the job was released to dispatch (P2-P4 clocks start here; P1 starts at booking = created_at).
ALTER TABLE jobs ADD COLUMN released_at TIMESTAMPTZ;
UPDATE jobs SET released_at = sla_started_at WHERE sla_started_at IS NOT NULL;
UPDATE jobs SET sla_started_at = created_at WHERE priority = 'emergency' AND sla_started_at IS NOT NULL;

-- SLA area is derived from the site suburb using the sla_areas setting, unless staff override it per site.
ALTER TABLE sites ADD COLUMN sla_area_override TEXT;
ALTER TABLE sites DROP COLUMN is_metro;
DELETE FROM settings WHERE key IN ('metro_cities', 'allow_emergency_below_minimum');

-- Monthly customer report: off by default for every customer (and globally) until switched on.
ALTER TABLE customers ADD COLUMN monthly_report_enabled BOOLEAN NOT NULL DEFAULT false;
