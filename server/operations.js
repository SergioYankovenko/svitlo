import { failureCode } from "./source-errors.js";
export async function runLoggedJob(db, job, work, now = () => Date.now()) {
  let run;
  try { run = await db.startJob(job, now()); } catch { console.error("service_job_log_unavailable"); }
  const finish = async (status, summary, error = null) => {
    if (!run) return;
    try { await db.finishJob(run, status, summary, error, now()); }
    catch { console.error("service_job_log_write_failed"); }
  };
  try {
    const result = await work();
    const summary = Object.fromEntries(["status","version","rules","refreshed","sent","failedRefreshes","partialRefreshes","failedDeliveries","expiredSubscriptions","skippedRefreshes","remindersChecked","budgetExhausted","feedChecks","failedFeeds"].filter(k => result[k] !== undefined).map(k => [k,result[k]]));
    if (result.review) summary.review = result.review;
    const status = result.status === "not_due" ? "not_due" : result.status === "held_for_review" ? "needs_review"
      : ["failed_retained","activated_state_retry"].includes(result.status) ? "failed"
      : result.failedRefreshes || result.partialRefreshes || result.failedDeliveries || result.failedFeeds ? "partial" : "succeeded";
    await finish(status, summary);
    return result;
  } catch (error) { await finish("failed", {}, failureCode(error)); throw error; }
  finally { if(!db.scheduledMaintenance)try { await db.opsCleanup(); } catch { console.error("service_ops_cleanup_failed"); } }
}
