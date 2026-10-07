import { esc } from "../lib/html";

const EFFECTIVE_DATE = "October 6, 2026";

type LegalBlock = string | { heading: string } | { items: string[] };

function legalDocument(title: string, blocks: LegalBlock[]): string {
  const body = blocks
    .map((block) => {
      if (typeof block === "string") return `<p>${esc(block)}</p>`;
      if ("heading" in block) return `<h2>${esc(block.heading)}</h2>`;
      return `<ul>${block.items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
    })
    .join("");
  return `<article class="panel legal">
    <h1>${esc(title)}</h1>
    <p class="effective muted">Effective Date: ${esc(EFFECTIVE_DATE)}</p>
    ${body}
  </article>`;
}

export function privacyPage(): string {
  return legalDocument("Privacy Policy", [
    `Tango Mar Property Owners Association, Inc. ("Association," "we," "us," or "our") respects the privacy of its members and other authorized users of this website and owner portal.`,
    "This Privacy Policy explains what information we may collect, how we use it, and how access to member, property, and account information is handled.",
    { heading: "Information We Collect" },
    "We may collect and maintain information associated with Association membership and use of the portal, including:",
    {
      items: [
        "Name",
        "Mailing address",
        "Email address",
        "Telephone number",
        "Property address, lot number, or other property information",
        "Association account balances",
        "Charges, assessments, payments, credits, and ledger information",
        "Communications submitted through the portal",
        "Documents or forms submitted to the Association",
        "Login and authentication information",
        "IP address, browser, device, and technical information used for security and system operation",
        "Other information reasonably necessary to administer the Association and provide portal services",
      ],
    },
    { heading: "How We Use Information" },
    "The Association may use information collected through the portal to:",
    {
      items: [
        "Maintain Association membership and property records",
        "Provide owners with access to information associated with their property",
        "Display account balances, assessments, payments, and ledger activity",
        "Process or facilitate payments",
        "Distribute Association notices, documents, meeting information, and announcements",
        "Respond to questions, requests, and communications",
        "Maintain and improve the website and portal",
        "Protect the security of member accounts and Association records",
        "Comply with legal, accounting, recordkeeping, and Association obligations",
      ],
    },
    { heading: "Property and Account Privacy" },
    "Owners may view the properties or lots linked to their authorized account.",
    "Other residents cannot view another owner's private account, ledger, payment history, or other restricted financial information through the portal.",
    "Users with authorized Association administrator access may view member and financial information when necessary to perform Association duties. Administrator access is limited to this Association. Administrators cannot access the records, ledgers, or financial information of unrelated associations that may use the same website platform or technology.",
    { heading: "Login and Authentication" },
    `The portal may use passwordless or "magic link" authentication.`,
    "Sign-in links are intended only for the person who controls the email address to which the link is sent. Users should not forward sign-in links or permit unauthorized persons to access their email account for the purpose of entering the portal.",
    "Users should notify the Association if they believe their email account, login access, or portal information has been compromised.",
    { heading: "Payments" },
    "Payments may be processed through a third-party payment provider.",
    "When payment information is submitted directly to a payment processor, the Association may receive transaction information such as the payment amount, date, status, and identifying details necessary to apply the payment to the appropriate account.",
    "The Association does not intend to store complete credit card numbers or complete bank account credentials submitted directly to a third-party payment processor.",
    "Payment processors may maintain their own privacy policies and terms.",
    { heading: "Association Documents" },
    "The portal may provide access to Association documents, including covenants, bylaws, rules, meeting materials, notices, financial information, and other records.",
    "The Association attempts to make current information available through the portal. However, if there is any conflict between information displayed on the website and an official Association record, recorded document, adopted resolution, official ledger, or other controlling record, the official record will govern.",
    { heading: "Service Providers" },
    "The Association may use third-party vendors to provide services such as:",
    {
      items: [
        "Website hosting",
        "Email delivery",
        "Data storage",
        "Authentication",
        "Payment processing",
        "Website security",
        "Accounting or Association management services",
      ],
    },
    "These providers may receive information reasonably necessary to perform services for the Association.",
    { heading: "Disclosure of Information" },
    "The Association may disclose information when reasonably necessary to:",
    {
      items: [
        "Administer the Association",
        "Provide requested services",
        "Work with authorized vendors, accountants, attorneys, managers, or contractors",
        "Comply with applicable law, court orders, subpoenas, or governmental requests",
        "Protect the Association, its members, its property, or its legal rights",
        "Respond to lawful requests for Association records",
      ],
    },
    "Nothing in this Privacy Policy is intended to limit any right of access to Association records that may exist under applicable law or the Association's governing documents.",
    { heading: "Data Security" },
    "The Association and its service providers use reasonable administrative, technical, and organizational measures intended to protect information from unauthorized access, loss, misuse, or disclosure.",
    "No website, computer system, email system, or electronic storage method can be guaranteed to be completely secure.",
    { heading: "Data Retention" },
    "Information may be retained for as long as reasonably necessary to administer the Association, maintain its records, comply with legal or accounting requirements, resolve disputes, and protect the Association's rights.",
    { heading: "Children's Privacy" },
    "The portal is intended for Association members, property owners, authorized representatives, and other authorized users. It is not intended for use by children.",
    { heading: "Changes to This Privacy Policy" },
    "The Association may update this Privacy Policy from time to time.",
    "The current version will be posted on the website with an updated effective date.",
    { heading: "Contact" },
    "Questions about this Privacy Policy or the use of information through the portal may be directed to the Association through the contact information provided on this website.",
  ]);
}

export function termsPage(): string {
  return legalDocument("Terms of Use", [
    "These Terms of Use govern access to and use of the Tango Mar Property Owners Association website and owner portal.",
    "By using the website or portal, you agree to these Terms of Use.",
    { heading: "Authorized Use" },
    "The owner portal is intended for Association members, property owners, authorized representatives, Association administrators, and other persons authorized by the Association.",
    "Users may access only the information and functions made available to their account.",
    "You may not attempt to access another owner's account, ledger, private information, or restricted Association records without authorization.",
    { heading: "Account Access and Security" },
    "Users are responsible for maintaining control of the email account or other authentication method used to access the portal.",
    "If the portal uses one-time or passwordless sign-in links, those links are intended only for the recipient and should not be forwarded or shared.",
    "Users should notify the Association promptly if they believe their account or authentication method has been compromised.",
    { heading: "Property and Financial Information" },
    "The portal may display information associated with properties linked to a user's account, including balances, assessments, payments, credits, and ledger activity.",
    "Other residents do not have access to another owner's private financial account information through the portal.",
    "Authorized administrators may access information necessary to administer this Association.",
    "Administrator access is limited to this Association and does not provide access to records belonging to unrelated associations using the same website platform or technology.",
    { heading: "Accuracy of Information" },
    "The Association makes reasonable efforts to keep information on the website current and accurate.",
    "However, website information is provided for convenience and may occasionally contain delays, errors, omissions, pending transactions, or outdated information.",
    "The Association's official records, governing documents, recorded instruments, adopted resolutions, approved minutes, official financial records, and official account ledgers control in the event of any inconsistency.",
    { heading: "Assessments, Balances, and Payments" },
    "Balances shown through the portal may be affected by pending payments, returned payments, late charges, adjustments, credits, collection activity, or other transactions that have not yet been reflected online.",
    "A balance displayed on the website should not be interpreted as a waiver of any amount lawfully owed to the Association.",
    "Payment processing may be provided by a third party and may be subject to that provider's terms and policies.",
    { heading: "Association Documents" },
    "Documents made available through the portal are provided as a convenience to members.",
    "The Association may designate particular documents as current versions.",
    "If there is any conflict between a website copy and an official recorded or adopted document, the official document controls.",
    { heading: "No Legal, Accounting, or Professional Advice" },
    "Information provided through the website is for Association and informational purposes only.",
    "Nothing on the website should be interpreted as legal, tax, accounting, engineering, insurance, or other professional advice.",
    "Members should consult the appropriate professional regarding matters requiring professional advice.",
    { heading: "Website Availability" },
    "The Association does not guarantee that the website or portal will always be available, uninterrupted, secure, or error-free.",
    "Access may be temporarily suspended for maintenance, security, updates, technical issues, or other reasons.",
    { heading: "Prohibited Activities" },
    "Users may not:",
    {
      items: [
        "Attempt to gain unauthorized access to accounts, systems, or data",
        "Use another person's account without permission",
        "Interfere with the operation or security of the website",
        "Introduce malicious code or harmful software",
        "Scrape, harvest, or systematically extract restricted information",
        "Misrepresent their identity or authority",
        "Use portal information for unlawful purposes",
        "Distribute another owner's private account or financial information without authorization",
      ],
    },
    { heading: "Links and Third-Party Services" },
    "The website may contain links to third-party websites or services.",
    "The Association is not responsible for the content, availability, privacy practices, security, or operation of third-party services.",
    { heading: "Limitation of Responsibility" },
    "To the extent permitted by law, the Association is not responsible for losses arising solely from temporary website outages, unauthorized access caused by a user's failure to protect their email or authentication credentials, third-party service interruptions, or reliance on information that differs from an official Association record.",
    "Nothing in these Terms is intended to waive any legal right or responsibility that cannot lawfully be waived.",
    { heading: "Governing Law" },
    "These Terms of Use are governed by the laws of the State of Florida, without regard to conflict-of-law principles.",
    { heading: "Changes to These Terms" },
    "The Association may revise these Terms of Use from time to time.",
    "The current version will be posted on the website with an updated effective date.",
    { heading: "Contact" },
    "Questions regarding these Terms of Use may be directed to the Association through the contact information provided on this website.",
  ]);
}
