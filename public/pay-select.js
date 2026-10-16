(function () {
  var form = document.querySelector("form[data-pay-select]");
  if (!form) return;
  var total = form.querySelector("[data-pay-total]");
  function money(cents) {
    var negative = cents < 0;
    var absolute = Math.abs(cents);
    var dollars = Math.floor(absolute / 100).toString();
    var change = String(absolute % 100).padStart(2, "0");
    dollars = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (negative ? "-$" : "$") + dollars + "." + change;
  }
  function render() {
    var cents = 0;
    var boxes = form.querySelectorAll('input[name="invoice_id"]');
    for (var index = 0; index < boxes.length; index += 1) {
      if (boxes[index].checked) cents += Number(boxes[index].getAttribute("data-cents") || 0);
    }
    if (total) total.textContent = money(cents);
  }
  form.addEventListener("change", render);
  render();
})();
