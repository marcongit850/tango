(function () {
  var form = document.querySelector("form[data-pay-select]");
  if (!form) return;
  var subtotalNode = form.querySelector("[data-pay-subtotal]");
  var feeNode = form.querySelector("[data-pay-fee]");
  var total = form.querySelector("[data-pay-total]");
  var enabled = form.getAttribute("data-fee-enabled") === "1";
  var bps = Number(form.getAttribute("data-fee-bps") || 0);
  var cap = Number(form.getAttribute("data-fee-cap-cents") || 0);
  function money(cents) {
    var negative = cents < 0;
    var absolute = Math.abs(cents);
    var dollars = Math.floor(absolute / 100).toString();
    var change = String(absolute % 100).padStart(2, "0");
    dollars = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (negative ? "-$" : "$") + dollars + "." + change;
  }
  function feeCents(subtotal) {
    if (!enabled || bps <= 0 || cap <= 0 || subtotal <= 0) return 0;
    if (bps >= 10000) return 0;
    var numerator = subtotal * bps;
    var denominator = 10000 - bps;
    var quotient = Math.floor(numerator / denominator);
    var remainder = numerator - quotient * denominator;
    var gross = remainder === 0 ? quotient : quotient + 1;
    return Math.min(cap, gross);
  }
  function render() {
    var cents = 0;
    var boxes = form.querySelectorAll('input[name="invoice_id"]');
    for (var index = 0; index < boxes.length; index += 1) {
      if (boxes[index].checked) cents += Number(boxes[index].getAttribute("data-cents") || 0);
    }
    var fee = feeCents(cents);
    if (subtotalNode) subtotalNode.textContent = money(cents);
    if (feeNode) feeNode.textContent = money(fee);
    if (total) total.textContent = money(cents + fee);
  }
  form.addEventListener("change", render);
  render();
})();
