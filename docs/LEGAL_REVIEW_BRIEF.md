# Legal review brief

**For:** Ridgeline's lawyer
**Re:** Customer service agreement, contractor agreement and privacy statement for LHA Holdings Limited (NZBN 9429052390173), trading as Ridgeline Facilities
**Drafts:** `/terms/customer`, `/terms/contractor` and `/privacy` in the app (source: `src/views/terms-customer.ejs`, `src/views/terms-contractor.ejs`, `src/views/privacy.ejs`). Version strings are in `src/services/terms.ts` (currently `2026-10-v2`). Each customer's and contractor's acceptance is recorded with the version and a timestamp.

The drafts were written alongside the software and have not had any legal review. Please review the whole set, but we need specific advice on the four issues below. Each one comes with the facts of how the system actually works, because the agreements have to match what the system does. The brief deliberately gives facts and questions only; it cites no legal authority.

---

## 1. Contractor agreement: independent-contractor status

**The issue.** We intend contractors to be engaged as independent contractors. The system gives Ridgeline significant control over how and when work is done. Please advise directly on the risk that contractors could be characterised as employees, and on what the agreement and our operating practice need to look like to keep that risk low.

**What the system does that points towards control or integration:**

| Feature | Detail |
| --- | --- |
| Dispatch | Ridgeline offers jobs and contractors accept or decline. Offers go out in waves ranked by ETA and **on-time record**. P1 offers go to every eligible contractor at once by SMS. |
| SLA deadlines | Each job has an on-site deadline and a made-safe or resolve deadline (P1: 2 h on site in metro areas). Breaches are flagged, shown to operations and escalated to staff phones. |
| Performance ranking | A contractor's past on-time rate affects whether they are offered work in early waves. |
| Mandatory evidence | Completion is blocked until arrival, start time, before and after photos, labour, materials and a report are recorded. Ridgeline reviews the evidence and can reject it. GPS and device timestamps are recorded where available. |
| Rate cards | Ridgeline agrees each contractor's rates, and invoices are checked against them. Overruns need an override. |
| Payment | Contractors invoice Ridgeline, never the customer. Ridgeline pays after approval. Deductions need the contractor's agreement. |
| Branding and customer contact | Customers deal only with Ridgeline. Contractors see site details only for jobs assigned to them. |

**What points the other way (present in the system or drafts):** contractors can decline any offer with no penalty other than ranking; they set their own regions, radius, availability and capacity; they may work for others; they supply their own tools, vehicle and insurance; they invoice with GST (where registered) and carry their own compliance documents; there are no rosters or minimum hours.

**Questions:**
1. Is the current mix defensible? Which features carry the most risk (for example on-time ranking affecting offers, or evidence review)?
2. What should the agreement say about the right to decline, freedom to work for others, substitution and subcontracting, no exclusivity, and no guaranteed work?
3. Should SLA obligations be framed as Ridgeline's obligations to its customers, with contractor-facing terms written as deliverables or outcomes rather than directions?
4. Does using decline history or on-time rate in dispatch create risk, and should it be disclosed or limited?
5. Do any operating practices (training, uniforms, vehicle signage) need a written policy?

## 2. Overlapping PCBU duties under HSWA 2015

**The issue.** Ridgeline (dispatching the work), each contractor (doing it) and often the customer or body corporate (controlling the site) may each have duties as a PCBU under HSWA 2015 in relation to the same work. We need to know how those overlapping duties should be handled and what the agreements must say.

**What the system does now:** sites have a hazards field and access notes, which are shown to the assigned contractor. Contractors must hold verified compliance documents (public liability and trade licences) before they are eligible. P1 has a "made safe" step. There is no site-induction record, no SWMS/JSA capture, no notifiable-incident workflow and no mechanism for the contractor to stop work and report.

**Questions:**
1. What must the contractor agreement say about how the overlapping duties are coordinated: hazard information flow, stop-work rights, incident and near-miss reporting, notifiable events, and subcontractors?
2. What must the customer agreement say about the customer's duties as the PCBU controlling the site or building (hazard disclosure, asbestos register, access)?
3. Which of these should the system enforce, for example a pre-start hazard check or an incident report on the job? Tell us and we will build it.

## 3. Customer agreement: what the published SLA table commits us to

**The issue.** The website and the app publish a priority matrix (P1 Emergency: on site 2 h metro / 4 h Rodney and Franklin, made safe 4 h / 8 h, 24/7; P2 Urgent: on site 8 business hours, resolved 2 business days; P3 Standard: on site 48 business hours, resolved 10 business days; P4 Scheduled: the agreed date). **At present it states targets with no remedy for a breach and no exclusions.** The system measures every job against these targets and reports performance to customers (the monthly report is built but switched off).

**How the clock works (so the agreement can describe it accurately):** P1 runs from booking, 24/7. P2–P4 run from release to dispatch, which follows funding and approval checks, in NZ business hours (8am–5pm Mon–Fri, excluding public holidays). Both the booked and released times are shown to the customer. The metro or non-metro area is set by the site's suburb. A site whose suburb is in no listed area must be confirmed by staff before non-emergency jobs can be booked, and its jobs are left out of SLA reporting until then.

**Unfunded emergencies (system facts):** a P1 is dispatched immediately even when the prepaid balance does not cover it, or when its estimate is above the customer's authority limit. In those cases the contractor is authorised for **make-safe work only**, up to a cap (default NZ$1,500 ex GST, adjustable per customer). Work beyond that needs the customer's approval or a recorded staff override. Once a customer's unpaid and unfunded balance passes a threshold, further unfunded P1s are held until on-call staff or finance release them for make-safe work, with a recorded reason. Whether to hold at all is a setting. During a hold the P1 clock keeps running from booking, and the hold time is shown on the job and reported separately. The published P1 target currently has no good-standing condition, and Ridgeline is deciding separately whether to add one. The published promise is "made safe", not "resolved".

**Questions:**
1. Are these targets or contractual service levels? With no stated remedy, what is our exposure, for business customers and separately for residential and small-business customers?
2. What remedy, if any, should we offer (service credits, fee waiver, sole-remedy clause, cap), and can it differ between business and residential customers?
3. What exclusions are needed: access refused or delayed, incorrect site information, customer-caused delay, weather, civil emergency, parts availability, events beyond our control, held jobs (funds or approval) for P2–P4, and work outside the Auckland areas?
4. Should "on site" and "made safe" be defined, and is our evidence (server timestamps and optional GPS) adequate?
5. Does the customer agreement need to authorise make-safe work on an unfunded or over-authority emergency, and the charge for it up to the cap, in advance? How should that consent be captured?
6. **Is our make-safe definition sufficient to limit scope contractually?** The contractor agreement (clause 4A) defines make-safe work as the minimum work reasonably necessary to remove or control an immediate risk of injury or further property damage until a permanent repair is arranged, with examples and exclusions. Contractors on a make-safe job must record what was made safe and what remains outstanding, and must not go further without approval confirmed in the app. Ridgeline is not obliged to pay for unapproved further work. The customer agreement (clause 3) uses the same definition and the cap. Is that wording enough to limit (a) what the contractor may do and charge, and (b) what the customer can be charged without further approval? What happens if a contractor reasonably believes further work is needed to make the site safe?

## 4. Prepaid balances: insolvency, termination and a possible trust

**The issue.** Customers prepay (minimum NZ$1,000; above NZ$15,000 by custom arrangement). Balances are recorded as a **liability** (customer advances), not revenue, and are applied to invoices as work is done. They are held in LHA Holdings Limited's ordinary bank account and are not segregated.

**Questions:**
1. If LHA Holdings Limited became insolvent, where would customers' prepaid balances stand? Must that be disclosed?
2. Should balances be held on trust to protect customers? What would that require in practice: a separate account, reconciliation and limits on use? The software can support a separate account and daily reconciliation.
3. On termination by either party: refund timing, deductions for work in progress and committed jobs, and refunding a minimum balance.
4. Does any regulatory regime apply to holding customer funds on account?
5. Body-corporate customers: are there constraints on a body corporate paying funds in advance?

## Also please confirm

- Privacy: storing GPS, photos of private residences, and the overseas providers we use (Twilio, Stripe, email, hosting, Xero).
- Auto top-up consent wording (`AUTO_TOPUP_CONSENT_TEXT` in `src/services/payments.ts`): is it enough for off-session card charges?
- Late-cancellation charges and the 35% markup disclosure in the customer agreement.

## Not for the lawyer: related open items

- **GST timing on top-ups:** awaiting accountant sign-off. See [GST_TIMING.md](GST_TIMING.md).
- **Invoice-on-terms accounts:** not yet approved.
