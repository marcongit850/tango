(function (root) {
  function paymentInvoicesForLot(options, propertyId) {
    return options.filter((option) => option.value === "" || option.propertyId === propertyId);
  }

  function installPaymentInvoiceFilter(doc) {
    const form = doc.querySelector("form[data-payment-form]");
    if (!form) return;
    const lot = form.querySelector('select[name="property_id"]');
    const invoice = form.querySelector('select[name="invoice_id"]');
    if (!lot || !invoice) return;
    const saved = Array.from(invoice.options, (option) => ({
      value: option.value,
      label: option.textContent || "",
      propertyId: option.getAttribute("data-property-id") || "",
    }));
    const apply = () => {
      const visible = paymentInvoicesForLot(saved, lot.value);
      const current = invoice.value;
      while (invoice.options.length > 0) invoice.remove(0);
      for (const item of visible) {
        const next = doc.createElement("option");
        next.value = item.value;
        next.textContent = item.label;
        if (item.propertyId) next.setAttribute("data-property-id", item.propertyId);
        invoice.appendChild(next);
      }
      const keep = Array.from(invoice.options).some((option) => option.value === current);
      invoice.value = keep ? current : "";
    };
    lot.addEventListener("change", apply);
    apply();
  }

  if (typeof document !== "undefined") installPaymentInvoiceFilter(document);
  else root.tangoLedgerPayment = { paymentInvoicesForLot, installPaymentInvoiceFilter };
})(globalThis);
