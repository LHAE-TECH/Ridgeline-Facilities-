# GST timing on prepaid top-ups: awaiting accountant sign-off

**Status: OPEN.** The current treatment is an assumption, not advice. Do not go live on it until Ridgeline's accountant has confirmed it in writing.

## What the system does now (deferred treatment)

| Event | Journal | GST |
| --- | --- | --- |
| Top-up or deposit received | Dr BANK / STRIPE_CLEARING, Cr CUSTOMER_PREPAID | **None.** Treated as a customer advance (liability). The receipt is not a tax invoice. |
| Work invoiced and prepaid credit applied | Dr CUSTOMER_PREPAID (+ AR for any remainder), Cr MAINTENANCE_REVENUE, Cr GST_OUTPUT | Output tax on the tax invoice, at issue. |
| Refund of unused balance | Dr CUSTOMER_PREPAID, Cr BANK | None. |

Code:

- Top-ups: `confirmPayment` in `src/services/payments.ts` (calls `prepaidMovement` with no GST line).
- Invoice issue: `issueCustomerInvoice` in `src/services/customerInvoices.ts` (the `GST_OUTPUT` credit line).
- Refunds and reversals: `markRefundPaid` and `reversePayment` in `src/services/payments.ts`.

## Why it may not survive review

Under the Goods and Services Tax Act 1985, the time of supply is the earlier of invoice issue or **receipt of any payment** for the supply (s 9(1)). If a top-up counts as payment for a supply, output tax arises when it is received, not when work is invoiced. That is especially likely for payments-basis registrants, or where a top-up is linked to identified future work. A pure deposit or security, refundable and not yet attributable to any supply, is generally treated differently. Ridgeline's balances are refundable and applied as work happens, which supports deferral, but this is a judgement for the accountant, possibly with an IRD ruling.

**Questions for the accountant:**

1. Is a refundable prepaid maintenance balance payment for a supply at receipt, or a deposit until applied?
2. Does LHA Holdings Limited account on invoice, payments or hybrid basis?
3. If GST arises at receipt: is a tax invoice required for each top-up, and how is GST on unused balances refunded (credit note / s 25 adjustment)?
4. Treatment of auto top-ups and of the minimum balance itself.

## What changes if GST must be accounted for at receipt

The ledger is built so this is a contained change:

1. **Top-up journal:** split the credit, Cr CUSTOMER_PREPAID (ex GST) + Cr GST_OUTPUT (3/23 of the receipt), or post to a new `GST_OUTPUT_ADVANCE` account if the accountant prefers to track it separately.
2. **Invoice issue:** when prepaid credit is applied, the GST on that portion has already been returned, so the invoice must not account for it again. Only GST on any receivable remainder is new output tax.
3. **Refunds and reversals:** reverse the GST portion (s 25 adjustment), with a credit note.
4. **Documents:** a top-up receipt becomes a tax invoice (needs GST number, `TAX INVOICE` heading and GST amount). `pdf.ts` already renders those fields for invoices.
5. **Xero mapping:** the GST code on top-up receipts.
6. **Tests:** `booking-ledger.test.ts` and `invoicing-payments.test.ts` assert the current journals and would be updated to the confirmed treatment.

Estimated effort: about 1–2 days including tests, once the treatment is confirmed. Existing journals are append-only, so any balances received before the change would be corrected with adjusting journals, not by editing history.
