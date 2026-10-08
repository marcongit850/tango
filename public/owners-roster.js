(function () {
  function openAway(link, event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      window.open(link.href, "_blank", "noopener");
      return;
    }
    window.location.assign(link.href);
  }

  function installOwnersRoster(doc) {
    var root = doc.querySelector(".lot-roster");
    if (!root || root.getAttribute("data-roster-ready") === "1") return;
    root.setAttribute("data-roster-ready", "1");

    var folds = Array.prototype.slice.call(root.querySelectorAll(".lot-fold"));
    folds.forEach(function (fold) {
      var summary = fold.querySelector("summary");
      if (!summary) return;
      var sync = function () {
        summary.setAttribute("aria-expanded", fold.hasAttribute("open") ? "true" : "false");
      };
      sync();
      fold.addEventListener("toggle", sync);
      Array.prototype.forEach.call(summary.querySelectorAll("a"), function (link) {
        link.addEventListener("mousedown", function (event) {
          event.stopPropagation();
        });
        link.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          openAway(link, event);
        });
        link.addEventListener("auxclick", function (event) {
          if (event.button !== 1) return;
          event.preventDefault();
          event.stopPropagation();
          window.open(link.href, "_blank", "noopener");
        });
      });
    });

    var input = root.querySelector(".lot-search input");
    var empty = root.querySelector(".lot-search-empty");
    if (!input) return;
    input.addEventListener("input", function () {
      var query = input.value.trim().toLowerCase();
      var shown = 0;
      folds.forEach(function (fold) {
        var hay = (fold.getAttribute("data-search") || "").toLowerCase();
        var match = !query || hay.indexOf(query) !== -1;
        fold.hidden = !match;
        if (match) shown += 1;
      });
      if (empty) empty.hidden = shown !== 0;
    });
  }

  if (typeof document !== "undefined") installOwnersRoster(document);
})();
