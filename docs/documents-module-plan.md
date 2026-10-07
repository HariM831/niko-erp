# Documents module — the plan

Asked for on 1 Oct 2026, after studying Folderit: every document properly
stored and findable, correspondence registered with sequence numbers, and
signatures — plus what niko's own data makes possible. The feature list was
agreed with **version history and check-out/lock dropped**. Nothing here is
built yet. What Folderit itself does, read from its help centre on 7 Oct
2026, is in [folderit-notes.md](folderit-notes.md).

## Principles

- **One attachment mechanism.** Every file is an `attachments` row, as today.
  A document is a record that *owns* attachments (`entity_type = 'document'`),
  exactly as a bill owns its scan. The existing attachments on bills, receipts,
  weigh tickets and so on appear in the library and in search, untouched.
- **No versions.** A document's files can be added to (annexures). Replacing
  one sends the old file to the recycle bin; it is not kept as a version. A
  signed document's files are frozen — it can only be voided and re-issued.
- **Numbers like every niko number.** Taken from `document_series` inside the
  transaction, financial year in the prefix, counters back to 1 in April.
- **Nothing is ever hard-deleted** by a user: the recycle bin is admin-only
  and a purge is an explicit admin act.

## 1. Library

**Records**
- `document_folders`: a tree (parent, name, sort order), with a *confidential*
  flag. Seeded with: Legal, Licences & Registrations, Contracts &
  Agreements, Land & Lease, HR, Insurance, Vehicles, Correspondence,
  Policies & Circulars, Bank & Finance, Miscellaneous.
- `document_types`: Licence, Agreement, Letter, Certificate, Policy,
  Notice, Invoice copy, ID proof, Other. Each type says which fields it
  carries (issue date, expiry, reference no., amount, party) and whether
  expiry is required.
- `documents`: a number (DOC-2026-27/00001), title, folder, type, status
  (Draft → Under review → Approved → Signed → Expired → Archived, or Void),
  party (contact), employee, issue date, expiry date, reference no., amount,
  tags, the type's own fields, physical location (box / shelf / file), a
  retention-until date, the deleted-at/by of the recycle bin, and who/when.
- `document_links`: the document ↔ any niko record (vendor, customer,
  employee, house, location, bill, PO, invoice, receipt, vehicle/asset).

**Screens**
- The library: a folder tree on the left and a list on the right, as Zoho
  Books' Documents screen lays it out — the real Zoho screens are read before
  this is built.
- Document page: a preview (PDF, image; Office files as a download with
  details), details, links, the activity on it, and its signatures, approvals
  and acknowledgements.
- A **Documents** tab on every linked record (contact, employee, house…),
  next to the attachments it already has.
- Upload: drag and drop, several at once, into a folder. Scan from a phone:
  the camera, auto-crop, several pages made into one PDF.

## 2. Search

- Text is extracted once, on upload, into `attachment_text` (one row per
  attachment, with a Postgres full-text index). This covers every attachment
  — documents and the bills/receipts already on file alike.
  - A PDF with a text layer: `pdf-text.ts`, already in niko.
  - A scan or photo: OCR (Gemini, as bill extraction does today; it reads
    Assamese and Bengali too). Existing attachments are backfilled once.
- **AI suggestion on upload:** type, party, issue/expiry dates, reference
  number and amount are offered from the text; a person confirms.
- One search box across title, number, tags, fields and the text inside the
  files, with filters (folder, type, party, date, tag, uploader, status) and
  the matching words highlighted.

## 3. Correspondence register

- `correspondence`: direction (in / out), the number — **IN/2026-27/0001**,
  **OUT/2026-27/0001** — the date, the mode (post, courier, hand, email,
  WhatsApp), the party (a contact, or a free name and address), the subject,
  their reference, in-reply-to (making threads), assigned-to, a reply-by
  date, status (Open, Replied, Closed, No reply needed), and for outward the
  courier and AWB/tracking. The letter itself is a document (scan or
  generated PDF) linked to it.
- Inward: received → numbered → assigned → reminder before the reply-by date
  → closed with the reply linked.
- Outward: drafted from a **letter template** on the letterhead, numbered on
  issue (the number and a QR code printed on it), dispatched, tracked.
- A thread view per party: the whole trail of letters both ways.
- **Email-in:** mail forwarded to a niko address (e.g. docs@aminofarms.com)
  is read from that mailbox, filed as inward correspondence with its
  attachments, and waits for someone to classify it.
- The register printed or exported for a period, as the paper register was.

## 4. Signatures, approvals, acknowledgements

- **In-app e-signature:** the signer, signed in to niko, draws or types their
  signature; niko stamps it on the PDF and appends a certificate page (who,
  when, IP, device), and stores the SHA-256 of the signed file. Good for
  internal approvals and acknowledgements.
- **Digital signature (DSC, Class 3 USB token):** the signature is embedded in
  the PDF itself (PAdES), valid under the IT Act. A browser cannot reach a USB
  token directly, so this needs the token maker's signing utility (emSigner
  or similar) on the signing PC. Phase 5.
- **Aadhaar eSign** for outside parties — vendors, landlords, workers —
  through a licensed eSign provider (eMudhra, Leegality, Digio, SignDesk…):
  niko sends the PDF and gets back a signed one. Per-signature cost, an
  account with the provider. Phase 5.
- **Signature requests:** one or more signers in order, each by in-app,
  DSC or Aadhaar, with reminders; the document shows who has signed.
- **Tamper check:** the stored hash is re-checked on every view; a changed
  file shows the signature as broken. A QR code on the document opens a
  public verification page (number, title, issuer, signers, hash OK / not).
- **Approval workflows:** reusable routes (e.g. Accountant → Director), steps
  in order or in parallel, approve / reject with a comment, status moving
  with them.
- **Read & acknowledge:** a policy or circular sent to people or roles; each
  confirms they have read it; the document shows who has and hasn't.

## 5. Expiry and compliance

- Expiry dates on any document; reminders 90, 30 and 7 days before; an
  **Expiring soon** list on the documents home and on the Home page.
- **Renewals:** the new licence is linked to the one it replaces, which
  becomes Expired/Archived.
- **Checklists:** the document types each kind of record must hold —
  - vendor / customer: GST certificate, PAN, cancelled cheque, agreement;
  - employee: ID proof, address proof, appointment letter, bank proof;
  - site (Nabil, Dhekiajuli): trade licence, FSSAI, pollution consents, fire
    NOC, factory licence…;
  - vehicle / asset: RC, insurance, fitness, permit, PUC.
  Each record shows held / missing / expired; a report lists the gaps.
- Retention: a type carries a retention period; at its end the document is
  flagged for review, never deleted on its own.

## 6. Access and security

- A new **Documents** permission module, split by page (library,
  correspondence, signatures, settings), as the Feed Mill's is.
- Folder permissions on top of roles: none / view / upload-only / download /
  edit / manage, for a role or a named user; confidential folders are visible
  only to those named.
- **Watermark** on preview and download: the viewer's name, the date and time.
- **Share links** for an auditor, bank or lawyer: an expiry, an optional
  password, a view limit, revocable, every open logged.
- `document_events`: every view, download, share, signature, approval,
  move and delete — views included, which today's activity log does not
  record.
- Recycle bin: admin only, restore or purge.

## 7. Generation

- Templates: offer and appointment letters, experience certificate, NOC,
  vendor letters, notices — placeholders filled from the contact or employee,
  on the letterhead from the organisation profile, numbered and QR-coded.
- A combined PDF: several documents selected, one file out.

## 8. Home and reports

- Documents home: recent, assigned to me, waiting for my signature or
  approval, to acknowledge, expiring soon, correspondence awaiting reply.
- Reports (on the Reports page, in a Documents card): the correspondence
  register, pending replies, the licence & expiry register, compliance gaps,
  the signature log, storage used.

## Phases

1. **Library**: folders, types, documents, links, upload and phone scan,
   permissions, the events log, recycle bin, physical location; text
   extraction and search (with the backfill of existing attachments); AI
   suggestions.
2. **Correspondence**: registers and numbering, threads, assignment and
   reminders, letter templates with QR, the printed register.
3. **Expiry and compliance**: reminders, renewals, checklists, the
   expiring-soon lists, retention flags.
4. **Approvals and in-app signing**: workflows, acknowledgements, in-app
   e-signature, tamper check, verification page, share links, watermark.
5. **External**: DSC signing, Aadhaar eSign, email-in.

## Decisions needed

1. **File storage and backup.** Uploads live on the droplet's disk only, with
   no copy elsewhere. Before company papers go in: move files to
   DigitalOcean Spaces (about $5/month for 250 GB) with a nightly copy, or
   keep them on disk with a nightly off-site backup?
2. **Upload size:** 10 MB today; 25 MB for documents?
3. **Vehicles and assets** have no register in niko. A small vehicle/asset
   list for their papers, or file them under a folder with tags only?
4. **Aadhaar eSign provider**, and whether outside parties will sign at all.
5. **DSC:** who holds Class 3 tokens and which make (ePass, ProxKey,
   HYP2003…)?
6. **Email-in mailbox:** which mail service hosts @aminofarms.com?
7. **Reminders:** in-app only, or also WhatsApp links / email?
8. **Number formats:** DOC-2026-27/00001, IN/2026-27/0001, OUT/2026-27/0001
   — or the farm's existing register style?
9. **Who manages documents** — which roles get which folders at the start?
