# Legal review brief

**For:** Ridgeline's lawyer
**Re:** Customer service agreement, contractor agreement and privacy statement for LHA Holdings Limited (NZBN 9429052390173), trading as Ridgeline Facilities
**Drafts:** `/terms/customer`, `/terms/contractor` and `/privacy` in the app (source: `src/views/terms-customer.ejs`, `src/views/terms-contractor.ejs`, `src/views/privacy.ejs`). Version strings are in `src/services/terms.ts` (currently `2026-10-v1`). Each customer's and contractor's acceptance is recorded with the version and a timestamp.

The drafts were written alongside the software and have not had any legal review. Please review the whole set, but we need specific advice on the four issues below. Each one comes with the facts of how the system actually works, because the agreements have to match what the system does.

---

## 1. Contractor agreement: independent-contractor status

**The risk.** We want contractors engaged as independent contractors. But the system gives Ridgeline a lot of control over how and when work is done, and that control is the kind of thing a court weighs when deciding whether someone is really an employee under s 6 of the Employment Relations Act 2000, which looks at the real nature of the relationship. The NZ *Uber* litigation (*E Tū v Rasier*, Employment Court and Court of Appeal, with a further appeal to the Supreme Court; please confirm its current status) shows how much weight control and integration carry for app-dispatched work. Please advise directly on the employee-characterisation risk and what the agreement and our operating practice need to look like to keep it low.

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

**The issue.** Under the Health and Safety at Work Act 2015, Ridgeline (dispatching the work), each contractor (doing it) and often the customer or body corporate (controlling the site) are each a PCBU with duties in relation to the same work. Section 34 requires PCBUs with overlapping duties to consult, cooperate and coordinate activities, so far as is reasonably practicable. These duties cannot be contracted out of (s 28), but the agreement can set out how they are coordinated.

**What the system does now:** sites have a hazards field and access notes, which are shown to the assigned contractor. Contractors must hold verified compliance documents (public liability and trade licences) before they are eligible. P1 has a "made safe" step. There is no site-induction record, no SWMS/JSA capture, no notifiable-incident workflow and no mechanism for the contractor to stop work and report.

**Questions:**
1. What must the contractor agreement say about how the overlapping duties are coordinated: hazard information flow, stop-work rights, incident and near-miss reporting, notifiable events (s 23–25 and WorkSafe notification), and subcontractors?
2. What must the customer agreement say about the customer's duties as the PCBU controlling the site or building (hazard disclosure, asbestos register, access)?
3. Which of these should the system enforce, for example a pre-start hazard check or an incident report on the job? Tell us and we will build it.

## 3. Customer agreement: what the published SLA table commits us to

**The issue.** The website and the app publish a priority matrix (P1 Emergency: on site 2 h metro / 4 h Rodney and Franklin, made safe 4 h / 8 h, 24/7; P2 Urgent: on site 8 business hours, resolved 2 business days; P3 Standard: on site 48 business hours, resolved 10 business days; P4 Scheduled: the agreed date). **At present it states targets with no remedy for a breach and no exclusions.** The system measures every job against these targets and reports performance to customers (the monthly report is built but switched off).

**How the clock works (so the agreement can describe it accurately):** P1 runs from booking, 24/7. P2–P4 run from release to dispatch, which follows funding and approval checks, in NZ business hours (8am–5pm Mon–Fri, excluding public holidays). Both the booked and released times are shown to the customer. The metro or non-metro area is set by the site's suburb.

**Questions:**
1. Are these targets or contractual service levels? With no stated remedy, what is our exposure under the Contract and Commercial Law Act 2017 and, for residential or small-business customers, the Consumer Guarantees Act 1993 (reasonable time, reasonable care and skill) and the Fair Trading Act 1986 (representations about service, unfair contract terms for standard-form consumer and small trade contracts)?
2. What remedy, if any, should we offer (service credits, fee waiver, sole-remedy clause, cap), and is contracting out of the CGA possible for business customers (s 43)?
3. What exclusions are needed: access refused or delayed, incorrect site information, customer-caused delay, weather, civil emergency, parts availability, events beyond our control, held jobs (funds or approval) for P2–P4, and work outside the Auckland areas?
4. Should "on site" and "made safe" be defined, and is our evidence (server timestamps and optional GPS) adequate?

## 4. Prepaid balances: insolvency, termination and a possible trust

**The issue.** Customers prepay (minimum NZ$1,000; above NZ$15,000 by custom arrangement). Balances are recorded as a **liability** (customer advances), not revenue, and are applied to invoices as work is done. They are held in LHA Holdings Limited's ordinary bank account and are not segregated.

**Questions:**
1. If LHA Holdings Limited became insolvent, would prepaid balances be unsecured debts (Companies Act 1993, Sch 7 priorities)? Is that acceptable commercially, and must it be disclosed?
2. Should balances be held on trust (a trust account, or a *Quistclose*-style express trust) to protect customers? What would that require in practice: a separate account, reconciliation and limits on use? The software can support a separate account and daily reconciliation.
3. On termination by either party: refund timing, deductions for work in progress and committed jobs, and refunding a minimum balance.
4. Do any regulatory regimes apply to holding customer funds on account (for example AML/CFT, or the Financial Markets Conduct Act for stored value)? We believe not, but please confirm.
5. Body-corporate customers: are there constraints on a body corporate paying funds in advance under the Unit Titles Act 2010 and its regulations?

## Also please confirm

- Privacy Act 2020: storing GPS, photos of private residences, and the overseas providers we use (Twilio, Stripe, email, hosting, Xero). IPP 12 applies to cross-border disclosure.
- Auto top-up consent wording (`AUTO_TOPUP_CONSENT_TEXT` in `src/services/payments.ts`): is it enough for off-session card charges?
- Late-cancellation charges and the 35% markup disclosure in the customer agreement.

## Not for the lawyer: related open items

- **GST timing on top-ups:** awaiting accountant sign-off. See [GST_TIMING.md](GST_TIMING.md).
- **Invoice-on-terms accounts:** not yet approved.
