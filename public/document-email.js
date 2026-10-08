(function (root) {
  function emailOwnersAllowed(visibility) {
    return visibility !== "board";
  }

  function installDocumentEmailOwners(doc) {
    const select = doc.querySelector('select[name="visibility"]');
    const block = doc.querySelector("[data-email-owners]");
    if (!select || !block) return;
    const checkbox = block.querySelector('input[name="email_owners"]');
    const apply = () => {
      const show = emailOwnersAllowed(select.value);
      if (!show && checkbox) checkbox.checked = false;
      if (show && block.hidden && checkbox) checkbox.checked = false;
      block.hidden = !show;
    };
    select.addEventListener("change", apply);
    apply();
  }

  if (typeof document !== "undefined") installDocumentEmailOwners(document);
  else root.tangoDocumentEmail = { emailOwnersAllowed, installDocumentEmailOwners };
})(globalThis);
