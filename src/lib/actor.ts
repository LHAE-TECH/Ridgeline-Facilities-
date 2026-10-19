export type Role = 'admin' | 'ops' | 'finance' | 'customer' | 'contractor';

/** The authenticated user performing an action. System jobs use SYSTEM_ACTOR. */
export interface Actor {
  id: string | null;
  role: Role | 'system';
  name: string;
  email?: string;
  customerId?: string | null;
  customerRole?: 'owner' | 'approver' | 'booker' | 'viewer' | null;
  approvalLimitCents?: number | null;
  contractorId?: string | null;
  ip?: string;
}

export const SYSTEM_ACTOR: Actor = { id: null, role: 'system', name: 'System' };

export const STAFF_ROLES: Role[] = ['admin', 'ops', 'finance'];

export function isStaff(actor: Actor): boolean {
  return actor.role === 'admin' || actor.role === 'ops' || actor.role === 'finance' || actor.role === 'system';
}
