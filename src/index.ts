import { createApp } from "./app";
import { runDueAssessmentInvoices } from "./lib/issue-assessments";

const app = createApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  async scheduled(controller, env) {
    await runDueAssessmentInvoices(env.DB, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
