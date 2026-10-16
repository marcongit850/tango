import { createApp } from "./app";
import { runDueInvoiceEmails } from "./lib/invoice-emails";
import { runDueAssessmentInvoices } from "./lib/issue-assessments";
import { runAutomaticLateFees } from "./lib/late-fees";
import { exportPaymentAudit } from "./lib/online-payments";

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime);
    await runDueAssessmentInvoices(env.DB, now);
    await runDueInvoiceEmails(env, now);
    await exportPaymentAudit(env, now);
    await runAutomaticLateFees(env.DB, now);
  },
} satisfies ExportedHandler<Env>;
