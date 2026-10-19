import type { Db } from '../db.js';
import type { Actor } from '../lib/actor.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  customerId?: string | null;
  contractorId?: string | null;
  details?: Record<string, unknown>;
}

export async function audit(db: Db, actor: Actor, input: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, customer_id, contractor_id, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [actor.id, actor.role, input.action, input.entityType, input.entityId ?? null, input.customerId ?? null,
     input.contractorId ?? null, JSON.stringify(input.details ?? {}), actor.ip ?? null],
  );
}
