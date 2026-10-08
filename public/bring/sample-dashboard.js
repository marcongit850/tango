(function () {
  var dialog = document.getElementById("sample-dialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  var openers = document.querySelectorAll("[data-sample]");
  openers.forEach(function (el) {
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
