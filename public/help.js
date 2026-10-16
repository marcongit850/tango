(function (root) {
  function installHelpTips(doc, win) {
    var open = null;

    function place(button, pop) {
      var margin = 8;
      var rect = button.getBoundingClientRect();
      pop.hidden = false;
      pop.style.visibility = "hidden";
      pop.style.left = "0px";
      pop.style.top = "0px";
      pop.style.maxWidth = Math.max(160, win.innerWidth - margin * 2) + "px";
      var width = pop.offsetWidth;
      var height = pop.offsetHeight;
      var left = rect.left;
      var top = rect.bottom + 6;
      if (left + width > win.innerWidth - margin) left = win.innerWidth - margin - width;
      if (left < margin) left = margin;
      if (top + height > win.innerHeight - margin) {
        var above = rect.top - height - 6;
        top = above >= margin ? above : Math.max(margin, win.innerHeight - margin - height);
      }
      pop.style.left = left + "px";
      pop.style.top = top + "px";
      pop.style.visibility = "visible";
    }

    function closeTip(returnFocus) {
      if (!open) return;
      var button = open.button;
      var pop = open.pop;
      var home = open.home;
      pop.hidden = true;
      pop.style.visibility = "";
      button.setAttribute("aria-expanded", "false");
      if (home && pop.parentNode !== home) home.appendChild(pop);
      open = null;
      if (returnFocus) button.focus();
    }

    function openTip(button) {
      var id = button.getAttribute("aria-controls");
      var pop = id ? doc.getElementById(id) : null;
      if (!pop) return;
      if (open && open.button === button) {
        closeTip(false);
        return;
      }
      if (open) closeTip(false);
      var home = pop.parentNode;
      if (doc.body) doc.body.appendChild(pop);
      button.setAttribute("aria-expanded", "true");
      place(button, pop);
      open = { button: button, pop: pop, home: home };
      pop.focus();
    }

    doc.addEventListener(
      "click",
      function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var button = target.closest(".help-btn");
        if (button) {
          event.preventDefault();
          event.stopPropagation();
          openTip(button);
          return;
        }
        if (open && !open.pop.contains(target)) closeTip(false);
      },
      true,
    );

    doc.addEventListener("keydown", function (event) {
      if (!open || event.key !== "Escape") return;
      event.preventDefault();
      closeTip(true);
    });

    function reposition() {
      if (open) place(open.button, open.pop);
    }

    win.addEventListener("resize", reposition);
    win.addEventListener("scroll", reposition, true);
  }

  root.installHelpTips = installHelpTips;
  if (root.document && root.window) installHelpTips(root.document, root.window);
})(typeof globalThis !== "undefined" ? globalThis : this);
