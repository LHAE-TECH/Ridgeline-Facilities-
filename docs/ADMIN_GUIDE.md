# Administrator guide

## Roles

| Role | Can do |
| --- | --- |
| **Admin** | Everything: settings, pricing rule approval, custom arrangements, balance adjustments, payable adjustment approval, staff users |
| **Ops** | Dispatch, manual assignment, evidence review, quotes/variations, contractor onboarding and compliance, cancellations |
| **Finance** | Agree standard minimum balances, confirm receipts, funding exceptions, contractor invoice approval, issue customer invoices, credit notes, refunds, payment approval, batches and confirmation, propose pricing rules |
| Customer **owner** | Manage organisation, sites, contacts, auto top-up consent and refunds; book and approve any job |
| Customer **approver** | Book; approve jobs, quotes and variations up to their approval limit |
| Customer **booker** | Book jobs; jobs above the account authority limit wait for an approver |
| Customer **viewer** | Read only |
| **Contractor** | Accept/decline offers, record attendance and evidence, quotes/variations, invoice Ridgeline, maintain availability and compliance documents |

Every change to money, pricing, evidence, assignments or settings is written to the append-only audit log (**Admin → Reports → Audit log**).

## Daily routine

1. **Dashboard**: check overdue jobs, low-balance accounts, contractor invoices awaiting approval, payments due, failures (payments, emails, Xero) and expiring compliance documents.
2. **Dispatch board**: jobs on hold, awaiting dispatch, offered, assigned, on site and in evidence review. Red border means emergency; "SLA breached" means a respond-by or attend-by time has passed.
3. **Receipts**: confirm bank transfers you can see in the bank. This credits the prepaid balance and releases any held jobs automatically.
4. **Evidence review** (Jobs filtered to "Completed – evidence under review").
5. **Contractor invoices**: approve or reject, then issue the customer invoice draft.
6. **Payables**: approve for payment, batch, pay in internet banking, confirm.

## Customer onboarding and the minimum balance

1. The customer registers and adds sites and facilities (or staff do it while signed in as the owner).
2. On the customer page, click **Recalculate**. The assessment shows each facility's estimated monthly spend and every step of the formula:
   *Required minimum = Estimated monthly maintenance spend (incl. 35% markup and GST) × Coverage factor*, rounded up to the configured increment, with a NZ$1,000 floor.
3. Review and **Agree minimum balance**.
   - Standard (≤ NZ$15,000): finance or admin can accept the recommendation.
   - Above NZ$15,000, or any amount different from the recommendation: an **administrator** must enter the agreed amount and the reason or authority. The account is marked as a custom arrangement.
4. The account becomes `pending_deposit`, and turns `active` automatically once confirmed payments reach the agreed minimum.

### Worked results from the default assumptions

These test scenarios are calculated from the shipped defaults (standard service level, business-hours emergency cover). They are not price commitments, and they change whenever you edit the assumptions.

**Portfolio scale taper.** Larger portfolios have steadier, more predictable monthly spend, so each extra dollar of spend needs less prepaid cover. The setting `assessment_scale_bands` applies a marginal taper, like tax brackets:

| Monthly spend band (incl GST) | Share needing coverage |
| --- | --- |
| first $1,000 | 100% |
| $1,000–$3,000 | 85% |
| $3,000–$6,000 | 70% |
| above $6,000 | 60% |

The total requirement still rises with every unit added, but the per-unit requirement falls.

| Portfolio | Category | Monthly spend | Spend needing cover | Coverage | Recommended | Per unit | Custom arrangement? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 one-bedroom units | residential | $401.53 | $401.53 | 3× | $1,250 | $125 | No |
| 100 one-bedroom units | residential | $4,015.39 | $3,410.77 | 3× | $10,250 | $103 | No |
| 10 two/three-bed units | residential | $606.42 | $606.42 | 3× | $1,850 | $185 | No |
| 100 two/three-bed units | residential | $6,064.23 | $4,838.54 | 3× | $14,550 | $146 | No |
| 40 mixed residential (20 + 20) | residential | $2,015.93 | $1,863.54 | 3× | $5,600 | $140 | No |
| 5 small offices | commercial | $1,801.99 | $1,681.69 | 2× | $3,400 | $680 | No |
| 15 small offices | commercial | $5,405.97 | $4,384.18 | 2× | $8,800 | $587 | No |
| 30 small offices | commercial | $10,811.92 | $7,687.15 | 2× | $15,400 | $513 | **Yes** |
| 30 residential + 4 offices + 2 retail | mixed | $4,286.06 | $3,600.24 | 2.5× | $9,050 | $251 | No |

One-bedroom and two/three-bedroom units are different facility types with different cost assumptions, so compare per-unit figures within a type.

### Configuring the assumptions (Admin → Settings)

- **Facility assessment assumptions** (per facility type): jobs per unit per month, average contractor cost per job, callout share and average callout, emergency share and emergency cost multiplier, and planned monthly cost per unit. Add custom facility types as needed.
- **Coverage factors**: by customer category (residential, commercial, body corporate, retail, industrial, mixed, custom) and service level (standard, priority). A portfolio with more than one facility category is assessed as **mixed**.
- **General**: `min_balance_floor_cents`, `standard_max_balance_cents`, `balance_rounding_cents`, `assessment_markup_bps`, `emergency_cover_factor_bps`, `assessment_scale_bands`.

Changing assumptions does not change agreed balances. Recalculate and re-agree accounts when you want them to apply.

## Priorities and SLAs (published matrix)

| Priority | On site | Resolved | Clock |
| --- | --- | --- | --- |
| **P1 Emergency** | 2 hrs metro (setting `sla_p1_onsite_hours`); non-metro `sla_p1_non_metro_onsite_hours` (default 4) | Made safe 4 hrs metro; non-metro `sla_p1_non_metro_made_safe_hours` (default 8) | 24/7 clock hours |
| **P2 Urgent** | 8 business hrs | 2 business days | NZ business hours |
| **P3 Standard** | 48 business hrs | 10 business days | NZ business hours |
| **P4 Scheduled** | Agreed date / window | Agreed date | Agreed date |

- **Business hours** (`sla_business_hours`) default to 08:00–17:00 Monday–Friday, excluding the public holidays in Settings. A business day is the length of that window (9 hours), so "2 business days" means 18 business hours. Daylight saving changes are handled.
- **Areas (Auckland only)**: `sla_areas` lists each area, whether it is metro, and its suburbs. **Metro** (P1 2 h on site / 4 h made safe): Auckland Central, North Shore, West Auckland, East Auckland, South Auckland. **Non-metro** (P1 4 h / 8 h): Rodney, Franklin. A site's area comes from its **suburb** (required when adding a site; matching ignores case and macrons). To move an edge suburb, edit the lists in **Settings → sla_areas**: no deploy needed. To place one site differently from its suburb, use **SLA area** on the job page or the customer's portfolio to pin it, or choose "Follow suburb" to clear the pin. - **Unconfirmed areas.** A suburb in no list gets the stricter metro targets, but those targets were never agreed, so they never count as breaches:
  - The site appears in the dashboard's **Area unconfirmed** list, and ops are emailed when it is added.
  - **No P2–P4 job can be booked there until staff confirm the area**, either by pinning the site or adding the suburb to `sla_areas`.
  - A P1 is still accepted, because nothing delays an emergency. Set `unconfirmed_area_allows_p1` to false to refuse those too.
  - Jobs at an unconfirmed site are **excluded from SLA performance** (dashboard, breach counts, customer reports and the monthly PDF) and listed separately as "area unconfirmed". When the area is confirmed, their targets are recalculated for the real area and they are counted from then on.
- Area changes apply to SLA clocks started or recalculated after the change.
- **Intake classification**: the booking form asks three triage questions (safety risk / prevents normal use / planned work). A reported safety risk is always booked as **P1**, even if the booker chose lower. A booker who chooses a higher priority than the triage suggests is allowed, but the job is flagged "Review classification" for operations. Ops can **Reclassify** any open job with a reason; targets are recalculated from the original start time.
- **When the clock starts**: **P1 at booking**, and nothing holds a P1 (see Booking rules). **P2–P4 at release to dispatch**: jobs held for funds or customer approval have no clock until released. Every job record shows **booked** and **released** times and any gap between them (job pages, the monthly report and its average booked → released column), so a hold is visible, not hidden. The job page shows both legs (on site, resolved/made safe) with time left, at-risk or breached status.
- **P1 "made safe"**: the contractor taps *Site is made safe* with a note, which records the P1 resolution time. Completing the job also satisfies the resolution target.
- **Alerts**: when `sla_at_risk_bps` (75%) of a window has elapsed, operations are emailed. Breaches are flagged on the job, emailed, and for P1 also sent by **SMS to the escalation phones**.
- **Reporting**: the ops dashboard shows on-site and resolution performance per priority for the selected period, plus every open job that is at risk or breached. Customers can get a **monthly report** (Reports page and PDF, emailed on the 1st for the previous month) with the same per-priority performance, every job's booked and released times, and prepaid account movement. **It ships OFF.** It runs only for customers where both the global setting `monthly_report_enabled` and the customer's own *Send monthly SLA & spend report* toggle (customer page → Account terms, administrators only) are on. While it is off, the customer sees no Reports page and nothing is emailed.

## SLA-ranked dispatch and escalation

- Eligible contractors are ranked by SLA fit, not just first-come:
  1. Whether their estimated arrival fits the time left on the on-site target. ETA = distance from their base ÷ `travel_speed_kmh`, or `unknown_travel_minutes` without coordinates, plus `load_penalty_minutes` per active job.
  2. Their ETA adjusted for their on-time record over 180 days (no history counts as 80%).
- **Waves**: P1 is offered at once to every contractor who can make the target (`dispatch_wave_size.emergency = 0`). P2–P4 go to the best few first (default 3) and widen every `dispatch_wave_minutes` if nobody accepts. Within a wave the first acceptance wins, and duplicate assignment is still impossible. The job page shows each offer's wave, rank and ETA.
- **SMS**: P1 and P2 offers are also sent by SMS (`sms_offer_priorities`), as is any offer made outside business hours. The accepting contractor gets an SMS confirmation with the address and on-site deadline. For P1, the other offered contractors are told by SMS that the job has been taken. Contractors need a NZ mobile number on their profile; P1 is only offered to contractors with one.
- **Escalation**: if no contractor has accepted within `escalation_minutes` (P1 10, P2 60, P3 240, P4 1440), staff get an SMS (to `escalation_staff_phones`) and an email. A P1 with no eligible contractor at all escalates immediately.
- Enter the on-call phone numbers in **Settings → General → escalation_staff_phones**, e.g. `["021 555 0100"]`.

## Booking rules and exceptions

- **Funding check** at booking: routine and urgent jobs are held (`pending_funds`) while the prepaid balance is below the agreed minimum, or when the available balance (balance minus amounts committed to open jobs) is less than the job estimate.
- **P1 response is never held; P1 scope can be.** Emergency jobs are dispatched immediately, and their on-site and made-safe clocks run from booking. When the prepaid balance does not cover the job, or its estimate is above the customer's authority limit, the job is dispatched for **make-safe work only**:
  - The cap is `p1_unfunded_cap_ex_gst_cents` (default NZ$1,500 customer price ex GST), or the customer's own cap (customer page → Account terms; finance or administrator). The cap incl GST is committed against the account, and the contractor cost is limited to the cap's equivalent under the job's estimated pricing.
  - Contractors see **MAKE-SAFE ONLY** on the offer, the SMS, the confirmation and the job page. The customer is told why and can **Approve further work** on their job page.
  - Work beyond make-safe needs **the customer's approval** (owner, or an approver whose limit covers the estimate; approving a quote or variation also counts) or a **staff override with a reason** (ops or admin, on the job page's *Emergency scope* panel). Either is recorded on the job, in its events and in the audit log.
  - Until then, a contractor invoice above the make-safe authorisation is blocked, and a customer invoice above the cap cannot be issued.
  - The part of the commitment not covered by available funds is recorded as **unfunded**. The ops dashboard shows **total unfunded P1 exposure** (open jobs plus unpaid invoices for them), per customer.
  - **Suspension:** once a customer's unfunded balance (all unpaid invoices plus unfunded open P1 jobs) reaches `p1_unfunded_suspend_threshold_cents` (default NZ$3,000; per-customer override), what happens next depends on `p1_hold_at_threshold`:
    - **On (default):** further P1 jobs that cannot be funded are **held** (*awaiting funds*). The hold SMS goes to everyone with the **on-call P1 release** right, plus the escalation phones, and staff are emailed.
      - The person alerted can open the job and **Release for make-safe** with a reason. The release is make-safe scope only; it records an on-call funding exception and is written to the job history and the audit log. Finance and administrators can also release, and a top-up releases the job automatically.
      - **The P1 clock is never paused or reset.** It runs from booking throughout. The hold duration is shown on the job (admin and customer pages) and reported separately: the dashboard's *P1 held at threshold* figures and the monthly report's "Emergency jobs held before dispatch" section.
    - **Off:** jobs keep dispatching for make-safe scope, and staff are alerted that the threshold was exceeded.
  - Open exposure is capped at the account's real shortfall (commitments minus balance), so several P1s sharing one balance are counted once, and a top-up reduces it immediately.
- **On-call P1 release right**: Admin → Staff users → *Grant right* (a NZ mobile is required). The page warns if nobody holds it, or if an escalation phone belongs to nobody with the right (that phone would get the alert without the authority to act).
- **Make-safe work** means the minimum work reasonably necessary to remove or control an immediate risk of injury or further damage until a permanent repair is arranged (contractor agreement clause 4A). On a make-safe job the contractor's completion report must state **what was made safe** and **what remains outstanding**: both are required to submit, and to close the job. The outstanding work becomes a **follow-up** (Admin → Follow-ups, and on the dashboard). Staff **book** it as a new job (normal funding and approval rules apply) or **dismiss** it with a reason; both are audited. Nothing is left silently.
- Raising a held job to P1 releases it at once (subject to the rules above), with its clock running from the original booking time.
- **Funding exception**: on a held job, finance or admin can release it with a recorded reason.
- **Authority limit** (per customer, incl GST): P2–P4 jobs whose estimate exceeds it wait for an owner or approver.
- The estimate is **committed** against the available balance and released on cancellation or settled when the invoice is issued.

## Dispatch

Confirmed jobs are offered automatically to every eligible contractor. The job page shows each contractor's eligibility and the reasons for any ineligibility:

- registered for the trade, with the qualification **verified**;
- covers the site's region (or within their service radius);
- marked available and under their concurrent-job limit;
- emergency-capable for emergency jobs, and after-hours capable for jobs outside standard hours;
- has an **agreed rate card** for the trade;
- holds **verified, unexpired** documents: public liability insurance plus each document the trade requires (e.g. EWRB licence for electrical, PGDB licence for plumbing).

Offers expire after the configured minutes (`offer_expiry_minutes`: P1 10, P2 60, P3 240, P4 720). When every offer is declined or expires, the job returns to the queue and operations are emailed. **Manual assignment** is available to ops and admin; assigning an ineligible contractor needs an administrator and an override reason, which is audit-logged. **Unassign** returns a job to the queue.

## Evidence review

The job page shows every photo with its server upload time, the device-reported capture time (labelled as such), GPS position if the device shared it, and the file's SHA-256. Completion reports are versioned; earlier versions are kept.

Automatic flags: labour exceeding on-site time × workers (+10%), completion recorded more than 2 km from the site, and after-photo device times earlier than arrival.

**Approve**, or **request more evidence** (the reason is sent to the contractor). Evidence cannot be edited or deleted. Staff can **withdraw** an item with a reason (it is hidden from the customer but retained).

## Contractor invoices

Contractors submit invoices to Ridgeline from the job page. Rejected outright: wrong job reference, a duplicate invoice number (per contractor), a second live invoice for the same job, wrong arithmetic, GST charged by a non-registered contractor, or GST that isn't 15% of the subtotal.

Flagged for review: rates above the agreed card for the time window, more than one callout, time window not matching attendance, labour above the completion report, materials above the report or missing receipts (over NZ$50), variation charges without an approved variation (**blocking**), cancellation charges on a non-billable cancellation (**blocking**), a total over the authorised amount (+20%), a possible duplicate, and supplies over NZ$1,000 without taxable supply information.

**Approve** (recording a reason if there are warnings). This posts contractor cost and GST input, creates the payable, and drafts the customer invoice. **Reject** sends the reason to the contractor, who resubmits with a new invoice number.

## Customer invoices and pricing

The draft shows, for each line, the contractor cost, the customer price and exactly which rule priced it. Customers never see contractor costs or margins.

**Pricing rules** (Admin → Settings → Pricing rules):

- Categories: standard labour, standard callout, emergency callout, after-hours, weekend, public holiday, overnight, travel, materials, specialist trades, minimum job charge, variations, cancellations.
- Methods: **markup** on contractor cost (default 35%); **fixed customer rate** (e.g. a contract emergency rate per hour); **multiplier** on the standard customer price (ignores the contractor's own premium); **minimum** job charge.
- Scope: optionally per customer contract, per trade and per priority. The most specific approved rule wins.
- Each contractor line is priced by **one** rule. A time window is chosen by precedence (public holiday > overnight > weekend > after-hours), so premiums never stack.
- New or changed rules are **drafts** until an administrator approves them; approving retires the previous rule with the same scope. Disclose rules in the customer's agreement.

Worked example: contractor NZ$200 ex GST → customer NZ$270 ex GST (markup NZ$70, gross margin 25.93%) + GST NZ$40.50 = NZ$310.50. A NZ$100 callout → NZ$135.

**Issue** applies prepaid credit (unless the customer's agreement says not to), books any remainder as a receivable due under the customer's payment terms, and emails the invoice, completion report and statement. **Recalculate** a draft after correcting a rule. Issued invoices can only be corrected by **credit note**: the credit first reduces anything owing, and the rest is returned to the prepaid balance. **Apply available prepaid credit** settles an outstanding receivable from uncommitted credit (e.g. after a top-up).

## Disputes

Customers, contractors or staff can raise a dispute on a job. While it is open, the customer invoice cannot be issued and the contractor payable is put **on hold** (never reduced). Resolve it with a written resolution and, optionally, a credit amount (ex GST), which issues a credit note. Holds release automatically when no disputes remain open.

## Refunds, reversals and adjustments

- **Refunds** of prepaid balance: requested by the owner or staff, approved by finance (limited to the available balance), and deducted only when recorded as paid with a bank reference.
- **Failed payments**: mark a pending top-up as failed and the customer is notified. **Reverse** a confirmed payment (dishonour or chargeback): prepaid credit is clawed back, and any amount already spent becomes a receivable.
- **Balance adjustments** (goodwill credit or debit): administrators only, with a reason.

## Automatic top-ups with a saved card

1. The account owner clicks **Save a card for automatic top-ups**. Card details are entered on Stripe's secure page; Stripe handles any bank authentication (3-D Secure) at that point. Ridgeline stores only the brand, last four digits and expiry.
2. The owner authorises the top-up amount and trigger balance. The consent text names the card and the merchant (LHA Holdings Limited trading as Ridgeline Facilities), and is stored with the time and user.
3. When the balance falls below the trigger, the worker charges the card off-session, at most once per NZ day. The balance is credited **only when Stripe reports the payment succeeded**, and is idempotent across the API response and the webhook.
4. **Declines** are recorded with Stripe's reason and the customer is emailed. After `auto_topup_max_failures` (3) consecutive failures, automatic charging pauses until the card is replaced. Temporary network errors are retried with the same Stripe idempotency key, so a retry cannot charge twice.
5. Customers without a saved card can still consent to automatic top-up **requests**, which are paid by bank transfer.

## Contractor payments

1. **Payables** list: due date from the contractor's payment terms (independent of customer terms), documentation status, and a **cash warning** when the contractor is due before the matching customer funds have been received.
2. **Approve for payment** after documentation is complete. Optionally require a different approver from the invoice approver (`require_separate_payment_approver`).
3. **Adjustments**: proposed by finance and approved by a different administrator. Deductions also require the contractor's recorded agreement. Nothing is deducted automatically.
4. **Create batch** for payables due on or before a date, **Export CSV**, and upload it to internet banking. Scheduling or exporting does **not** mark anything paid.
5. **Confirm paid** with the bank payment reference and actual date, or **Reconcile bank statement** (CSV) to match debits automatically. The contractor receives a remittance advice.

## Jobs closing

Jobs close automatically (or via **Close job**) once evidence is approved, the contractor invoice is approved, the customer invoice is fully settled, the contractor payment is confirmed and no dispute is open. Each requirement can be changed in settings.

## Notifications and integrations

**Admin → Reports → Email outbox** shows every message and its true delivery status. **Integrations** shows live/test/unconfigured status, the Xero sync queue and received webhooks. **Run background tasks now** triggers the worker immediately.

## Contracting entity

The legal party on agreements, tax invoices, credit notes, completion reports, statements, remittances and email footers is taken from **Settings → Contracting entity & GST registration**. It defaults to **LHA Holdings Limited, NZBN 9429052390173, trading as Ridgeline Facilities**.

- Enter LHA Holdings Limited's **GST number** there before go-live. While Ridgeline is marked GST-registered with no GST number, GST invoices **cannot be issued**, and the settings page shows a warning.
- Customers accept the customer service agreement at registration and contractors accept the contractor agreement when applying. The version and date are recorded on the account. Both agreements are drafts for legal review (`/terms/customer`, `/terms/contractor`). Bump the version in `src/services/terms.ts` when the text changes.

## Contractor classification and health & safety

Contractors confirm at sign-up that they operate as independent businesses responsible for their own tax, insurance and health & safety. Site hazards recorded on each site are shown to the assigned contractor. Ridgeline should still have contractor agreements reviewed for employment-status risk and keep PCBU duties under the Health and Safety at Work Act 2015 in mind (coordinate, cooperate and consult with contractors).
