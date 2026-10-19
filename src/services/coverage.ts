import type { Db } from '../db.js';
import { query } from '../db.js';
import { haversineKm } from './dispatch.js';
import { getSettings } from './settings.js';
import { acceptanceStatus, versionIncludesMakeSafe } from './terms.js';

/**
 * Make-safe contractor coverage by SLA area (visibility only: dispatch itself is unchanged).
 *
 * For each area, a contractor counts when they are approved and P1-capable (emergency available, mobile for SMS),
 * cover the area under the dispatch coverage rule (service region, or service radius from their base to the area's
 * reference point), and could reach that reference point within the area's P1 on-site target at the configured
 * travel speed. Among those, "eligible" have accepted the current agreement including the make-safe clause;
 * "blocked" would count but their agreement version keeps them off make-safe jobs. Contractors with no base location
 * cannot be placed in an area and are listed separately.
 */
export async function makeSafeCoverage(db: Db) {
  const settings = await getSettings(db);
  const contractors = await query(db,
    `SELECT id, legal_name, trading_name, service_regions, base_lat, base_lng, service_radius_km, emergency_available, mobile_phone, agreement_version, status
       FROM contractors WHERE status = 'approved' ORDER BY legal_name`);
  const name = (c: any) => c.trading_name || c.legal_name;
  const p1Capable = contractors.filter((c) => c.emergency_available && c.mobile_phone);
  const areas = settings.sla_areas.map((area) => {
    const targetMinutes = Math.round((area.metro ? settings.sla_p1_onsite_hours : settings.sla_p1_non_metro_onsite_hours) * 60);
    const eligible: { id: string; name: string; travelMinutes: number }[] = [];
    const blocked: { id: string; name: string; travelMinutes: number; version: string | null }[] = [];
    if (area.centre) {
      for (const c of p1Capable) {
        if (c.base_lat == null || c.base_lng == null) continue;
        const km = haversineKm(c.base_lat, c.base_lng, area.centre.lat, area.centre.lng);
        const covers = (c.service_regions ?? []).includes('Auckland') || (c.service_radius_km != null && km <= Number(c.service_radius_km));
        const travelMinutes = Math.round((km / Math.max(1, settings.travel_speed_kmh)) * 60);
        if (!covers || travelMinutes > targetMinutes) continue;
        const ok = versionIncludesMakeSafe(c.agreement_version) && !acceptanceStatus('contractor', c.agreement_version).needsAcceptance;
        (ok ? eligible : blocked).push({ id: c.id, name: name(c), travelMinutes, ...(ok ? {} : { version: c.agreement_version }) } as any);
      }
    }
    return { name: area.name, metro: area.metro, targetMinutes, hasCentre: Boolean(area.centre), eligible, blocked,
      eligibleCount: eligible.length, blockedCount: blocked.length, warning: eligible.length < 2, zero: eligible.length === 0 };
  });
  const notCurrent = contractors.filter((c) => acceptanceStatus('contractor', c.agreement_version).needsAcceptance)
    .map((c) => ({ id: c.id, name: name(c), version: c.agreement_version as string | null }));
  return {
    areas,
    areasBelowTwo: areas.filter((a) => a.warning).map((a) => a.name),
    areasWithNone: areas.filter((a) => a.zero).map((a) => a.name),
    contractorsNotOnCurrentAgreement: notCurrent,
    baseUnknown: p1Capable.filter((c) => c.base_lat == null || c.base_lng == null).map((c) => ({ id: c.id, name: name(c) })),
    // Go-live gate 5: every active contractor on the current agreement, and no area with zero eligible contractors.
    goLiveReady: notCurrent.length === 0 && areas.every((a) => !a.zero),
  };
}
