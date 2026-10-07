import { issueOpenAssessmentInvoices, listAssociations, writeAudit } from "../db";
import { todayIso } from "./dates";
import { logError, logInfo } from "./log";

/** Creates invoices for every association whose assessments are open on `now` in that association's time zone. */
export async function runDueAssessmentInvoices(db: D1Database, now: Date): Promise<{ created: number }> {
  const associations = await listAssociations(db);
  let created = 0;
  const failures: string[] = [];
  for (const association of associations) {
    try {
      const today = todayIso(association.timezone, now);
      const issued = await issueOpenAssessmentInvoices(db, { associationId: association.id, today });
      const made = issued.filter((row) => row.created > 0);
      for (const row of made) {
        created += row.created;
        try {
          await writeAudit(db, {
            associationId: association.id,
            actorUserId: null,
            action: "assessment_assign",
            entityType: "assessment",
            entityId: row.assessmentId,
            detail: `Automatic on ${today}: ${row.name}: ${row.created} invoices, ${row.already} already assigned.`,
          });
        } catch (error) {
          logError("assessment_invoice_audit", {
            associationId: association.id,
            assessmentId: row.assessmentId,
            message: error instanceof Error ? error.message : "unknown",
          });
        }
      }
      logInfo("assessment_invoices", {
        associationId: association.id,
        today,
        created: made.reduce((sum, row) => sum + row.created, 0),
        assessments: made.map((row) => row.assessmentId),
      });
    } catch (error) {
      failures.push(association.id);
      logError("assessment_invoices", {
        associationId: association.id,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  if (failures.length > 0) {
    throw new Error(`Assessment invoicing failed for ${failures.join(", ")}.`);
  }
  return { created };
}
