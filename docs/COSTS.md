# Recurring costs (itemised)

Estimates for a small-to-medium operation (tens of customer accounts, up to a few hundred jobs per month). Prices were checked in October 2026 from public sources. **Confirm current pricing with each provider before committing**; foreign-currency prices move with the exchange rate. USD amounts are converted at roughly NZ$1.70 per US$1 for budgeting.

## Required

| Item | Provider (example) | Plan | Approx. cost / month | Notes |
| --- | --- | --- | --- | --- |
| Application hosting | Render web service | Starter (0.5 CPU, 512 MB) | US$7 (≈ NZ$12) | Standard (US$25) if the app needs more memory as usage grows |
| Managed PostgreSQL | Render Postgres | Basic 256 MB–1 GB | US$6–20 (≈ NZ$10–34) | Plan names and prices differ between sources; check Render's pricing page. The free tier expires and is not suitable |
| Staging environment | Render web service + Postgres + 1 GB disk | Starter + Basic | ≈ US$13–14 (≈ NZ$23) | Needed for the go-live gates and for testing changes before production. Can be suspended between releases to save cost |
| File storage | Render persistent disk | 5 GB | ≈ US$1.25 (≈ NZ$2) | Or Cloudflare R2: first 10 GB free, then about US$0.015/GB, with no egress fees |
| Transactional email | Postmark (or Amazon SES) | 10,000 emails | US$15 (≈ NZ$26) | SES is cheaper (about US$0.10 per 1,000) but needs more setup |
| Domain / DNS | Existing ridgelinefacilities.com | – | Existing cost | Subdomain `app.` costs nothing extra |
| Off-site backups | Cloudflare R2 / Backblaze B2 | < 10 GB | NZ$0–3 | |
| **Total required** | | | **≈ NZ$75–100 / month** (incl. staging ≈ NZ$23) | Plus SMS (about NZ$30–50/month at the volume above) once Twilio is enabled |

## Optional

| Item | Provider | Cost | When needed |
| --- | --- | --- | --- |
| Card top-ups and invoice payments | Stripe | No monthly fee. **2.65% + NZ$0.30** per domestic card payment online (international cards cost more) | Only if you accept cards. A NZ$5,000 deposit by card costs about NZ$132.80, so bank transfer is cheaper for large deposits |
| Accounting sync | Xero Custom Connection | About **NZ$10/month + GST** | Requires an existing Xero subscription (not included) |
| Xero subscription | Xero | Your existing plan | Most businesses already have one |
| SMS dispatch and escalation | Twilio | About **US$0.105 per SMS segment** to NZ mobiles (≈ NZ$0.18), plus a NZ number (about US$5–10/month; check Twilio's console) | Needed for after-hours P1 dispatch. Example: 30 P1/P2 jobs a month × 4 offer SMS + confirmations ≈ 150 SMS ≈ NZ$27/month |
| Contractor payout provider | – | Varies | Not used: payments are made by bank batch export at no extra cost |
| Error monitoring | Sentry (free tier) | NZ$0 | Recommended once live |
| Uptime monitoring | UptimeRobot (free tier) | NZ$0 | Monitor `/healthz` |

## One-off / periodic (not software)

- Accountant review of the prepaid account and GST treatment.
- Legal review of customer service agreements, pricing disclosure, privacy statement and contractor agreements.
- Contractor compliance checks are part of staff time.

## Scaling notes

- The system is efficient: one small instance handles hundreds of concurrent users. The database grows mainly with audit and journal rows, which is small (likely under 1 GB for years at this scale).
- Photos are the main storage cost. 500 jobs/month × 6 photos × 2 MB ≈ 6 GB/month, so move to R2 (about US$0.015/GB/month) once disk usage passes about 20 GB.

Sources: [Twilio NZ SMS pricing](https://www.twilio.com/en-us/sms/pricing/nz), [Render pricing articles](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses), [Render pricing summary](https://kuberns.com/blogs/render-pricing/), [Stripe NZ pricing notice](https://support.stripe.com/questions/lower-pricing-for-new-zealand-card-transactions-effective-starting-december-1-2025), [Xero Custom Connections](https://developer.xero.com/announcements/custom-integrations-are-coming), [Postmark pricing](https://postmarkapp.com/pricing.txt).
