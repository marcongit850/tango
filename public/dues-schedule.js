(function (root) {
  function duesAmountLabels(schedule) {
    const periods = {
      annual: "per year",
      semiannual: "per half year",
      quarterly: "per quarter",
      monthly: "per month",
    };
    const period = periods[schedule] || "per year";
    return {
      improved: "Improved lot amount " + period,
      unimproved: "Unimproved lot amount " + period,
    };
  }

  function installDuesScheduleLabels(doc) {
    const form = doc.querySelector("form[data-dues-schedule]");
    if (!form) return;
    const select = form.querySelector('select[name="schedule"]');
    if (!select) return;
    const apply = () => {
      const labels = duesAmountLabels(select.value);
      for (const kind of ["improved", "unimproved"]) {
        const label = form.querySelector('[data-dues-amount="' + kind + '"]');
        if (!label || !label.firstChild) continue;
        label.firstChild.textContent = labels[kind];
      }
    };
    select.addEventListener("change", apply);
  }

  if (typeof document !== "undefined") installDuesScheduleLabels(document);
  else root.tangoDuesSchedule = { duesAmountLabels, installDuesScheduleLabels };
})(globalThis);
