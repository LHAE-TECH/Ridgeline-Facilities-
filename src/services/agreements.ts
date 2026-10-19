import type { Db } from '../db.js';
import { maybeOne, one, query, tx } from '../db.js';
import type { Actor } from '../lib/actor.js';
import { AppError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { audit } from './audit.js';
import { acceptanceStatus, type AcceptanceStatus, type AgreementKind, currentVersion } from './terms.js';

/** Records acceptance of the current version (history row + current columns). */
export async function recordAcceptance(db: Db, actor: Actor, kind: AgreementKind, partyId: string, source: 'app' | 'registration' = 'app'): Promise<string> {
  const version = currentVersion(kind).version;
  await tx(db, async (c) => {
    if (kind === 'customer') {
      await c.query('UPDATE customers SET terms_version = $2, terms_accepted_at = now(), terms_accepted_by = $3 WHERE id = $1', [partyId, version, actor.id]);
    } else {
      await c.query('UPDATE contractors SET agreement_version = $2, agreement_accepted_at = now(), agreement_accepted_by = $3 WHERE id = $1', [partyId, version, actor.id]);
    }
    await c.query(`INSERT INTO agreement_acceptances (kind, version, customer_id, contractor_id, accepted_by, ip, source) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [kind, version, kind === 'customer' ? partyId : null, kind === 'contractor' ? partyId : null, actor.id, actor.ip ?? null, source]);
    await audit(c, actor, { action: `${kind}_agreement.accepted`, entityType: kind, entityId: partyId,
      customerId: kind === 'customer' ? partyId : undefined, contractorId: kind === 'contractor' ? partyId : undefined, details: { version, source } });
  });
  return version;
}

export async function customerTermsStatus(db: Db, customerId: string): Promise<AcceptanceStatus> {
  const c = await maybeOne(db, 'SELECT terms_version FROM customers WHERE id = $1', [customerId]);
  if (!c) throw new NotFoundError('Customer');
  return acceptanceStatus('customer', c.terms_version);
}

export async function contractorAgreementStatus(db: Db, contractorId: string): Promise<AcceptanceStatus> {
  const c = await maybeOne(db, 'SELECT agreement_version FROM contractors WHERE id = $1', [contractorId]);
  if (!c) throw new NotFoundError('Contractor');
  return acceptanceStatus('contractor', c.agreement_version);
}

export async function assertCustomerTermsCurrent(db: Db, customerId: string): Promise<void> {
  const s = await customerTermsStatus(db, customerId);
  if (s.needsAcceptance) {
    throw new AppError(`The service agreement has changed (version ${s.current}). An account owner or approver must accept it before jobs can be booked.`, 403, 'terms_reacceptance_required');
  }
}

export async function assertContractorAgreementCurrent(db: Db, contractorId: string): Promise<void> {
  const s = await contractorAgreementStatus(db, contractorId);
  if (s.needsAcceptance) {
    throw new AppError(`The contractor agreement has changed (version ${s.current}). Accept it before accepting jobs.`, 403, 'agreement_reacceptance_required');
  }
}

/** Whether this signed-in user must (and can) accept a new version now; used at sign-in and by the accept page. */
export async function pendingAcceptanceFor(db: Db, actor: Actor): Promise<{ kind: AgreementKind; partyId: string; status: AcceptanceStatus; canAccept: boolean } | null> {
  if (actor.role === 'customer' && actor.customerId) {
    const status = await customerTermsStatus(db, actor.customerId);
    return status.needsAcceptance ? { kind: 'customer', partyId: actor.customerId, status, canAccept: ['owner', 'approver'].includes(actor.customerRole ?? '') } : null;
  }
  if (actor.role === 'contractor' && actor.contractorId) {
    const status = await contractorAgreementStatus(db, actor.contractorId);
    return status.needsAcceptance ? { kind: 'contractor', partyId: actor.contractorId, status, canAccept: true } : null;
  }
  return null;
}

export async function acceptPendingAgreement(db: Db, actor: Actor): Promise<string> {
  const pending = await pendingAcceptanceFor(db, actor);
  if (!pending) throw new AppError('There is no new agreement to accept', 409);
  if (!pending.canAccept) throw new ForbiddenError('Only an account owner or approver can accept the service agreement for your organisation');
  return recordAcceptance(db, actor, pending.kind, pending.partyId);
}

export async function acceptanceHistory(db: Db, kind: AgreementKind, partyId: string) {
  return query(db,
    `SELECT a.*, u.name AS accepted_by_name FROM agreement_acceptances a LEFT JOIN users u ON u.id = a.accepted_by
      WHERE a.kind = $1 AND (a.customer_id = $2 OR a.contractor_id = $2) ORDER BY a.accepted_at DESC`, [kind, partyId]);
}

export async function contractorAgreementVersion(db: Db, contractorId: string): Promise<string | null> {
  return (await one(db, 'SELECT agreement_version FROM contractors WHERE id = $1', [contractorId])).agreement_version;
}
