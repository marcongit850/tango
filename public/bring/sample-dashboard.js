(function () {
  var labels = {
    demo: "Request a Demo",
    pricing: "Request Pricing",
    setup: "Schedule a Demo",
  };
  document.querySelectorAll("[data-demo-intent]").forEach(function (el) {
    el.addEventListener("click", function (event) {
      var form = document.getElementById("demo-form");
      var input = form && form.querySelector("input[name=intent]");
      if (!form || !input) return;
      event.preventDefault();
      var intent = el.getAttribute("data-demo-intent") || "demo";
      input.value = intent;
      var label = document.getElementById("demo-intent-label");
      if (label && labels[intent]) label.textContent = labels[intent];
      if (form.scrollIntoView) form.scrollIntoView({ block: "start" });
      var name = form.querySelector("input[name=name]");
      if (name && name.focus) name.focus();
    });
  });

  var dialog = document.getElementById("sample-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  document.querySelectorAll("[data-sample]").forEach(function (el) {
    el.addEventListener("click", function (event) {
      event.preventDefault();
      var shot = document.getElementById("sample-dashboard");
      if (shot && shot.scrollIntoView) shot.scrollIntoView({ block: "center" });
      dialog.showModal();
    });
  });
  dialog.addEventListener("click", function (event) {
    if (event.target === dialog) dialog.close();
  });
})();
