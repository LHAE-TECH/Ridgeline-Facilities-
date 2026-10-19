/**
 * Agreement versions and the re-acceptance policy.
 *
 * Every version of the customer service agreement (views/terms-customer.ejs) and the contractor agreement
 * (views/terms-contractor.ejs) is listed here, oldest first, and marked:
 *   - 'minor'    : wording or clarity changes; existing acceptances carry over, nobody is asked again.
 *   - 'material' : changes rights or obligations; anyone who accepted an earlier version must accept this one before
 *                  they can book (customers) or accept an offer (contractors).
 * When the text changes, add a new entry (never edit a published one) and decide its materiality.
 * The legal party is taken from Settings → company (LHA Holdings Limited trading as Ridgeline Facilities).
 */

export type AgreementKind = 'customer' | 'contractor';
export interface AgreementVersion {
  version: string;
  effective: string;
  materiality: 'minor' | 'material';
  summary: string;
  /** Contractor agreement only: contains the make-safe definition (clause 4A) that limits scope on capped jobs. */
  includesMakeSafe?: boolean;
}

export const AGREEMENT_VERSIONS: Record<AgreementKind, AgreementVersion[]> = {
  customer: [
    { version: '2026-10-v1', effective: '2026-10-01', materiality: 'material', summary: 'First published customer service agreement.' },
    { version: '2026-10-v2', effective: '2026-10-20', materiality: 'material',
      summary: 'P1 targets run from booking; unfunded or over-authority emergencies are dispatched for make-safe work only, up to a cap, with further work needing your approval; make-safe reports state what remains outstanding.' },
  ],
  contractor: [
    { version: '2026-10-v1', effective: '2026-10-01', materiality: 'material', includesMakeSafe: false, summary: 'First published contractor agreement.' },
    { version: '2026-10-v2', effective: '2026-10-20', materiality: 'material', includesMakeSafe: true,
      summary: 'Adds the make-safe definition (clause 4A): on MAKE-SAFE ONLY jobs you do make-safe work only, within the authorised amount, record what was made safe and what remains outstanding, and do no further work without approval in the app.' },
  ],
};

export function currentVersion(kind: AgreementKind): AgreementVersion {
  const list = AGREEMENT_VERSIONS[kind];
  return list[list.length - 1];
}

/** The oldest version a user may still be on: the latest material version. */
export function requiredVersion(kind: AgreementKind): AgreementVersion {
  return [...AGREEMENT_VERSIONS[kind]].reverse().find((v) => v.materiality === 'material') ?? AGREEMENT_VERSIONS[kind][0];
}

export interface AcceptanceStatus {
  accepted: string | null;
  current: string;
  required: string;
  needsAcceptance: boolean;
  /** Versions published after the accepted one (what changed), newest last. */
  changes: AgreementVersion[];
}

export function acceptanceStatus(kind: AgreementKind, accepted: string | null | undefined): AcceptanceStatus {
  const list = AGREEMENT_VERSIONS[kind];
  const idx = accepted ? list.findIndex((v) => v.version === accepted) : -1;
  const reqIdx = list.findIndex((v) => v.version === requiredVersion(kind).version);
  return {
    accepted: accepted ?? null, current: currentVersion(kind).version, required: list[reqIdx].version,
    needsAcceptance: idx < reqIdx, // nothing accepted, an unknown version, or one older than the latest material version
    changes: list.slice(idx + 1),
  };
}

export function versionIncludesMakeSafe(version: string | null | undefined): boolean {
  return AGREEMENT_VERSIONS.contractor.find((v) => v.version === version)?.includesMakeSafe === true;
}

export const CUSTOMER_TERMS_VERSION = currentVersion('customer').version;
export const CONTRACTOR_AGREEMENT_VERSION = currentVersion('contractor').version;
