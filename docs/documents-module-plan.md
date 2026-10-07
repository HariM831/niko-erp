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
- **Numbers per folder** (decided 7 Oct 2026, as Folderit does it). Each
  folder can carry its own numbering scheme, optionally passed down to its
  subfolders, so Contracts and Licences keep separate series. Taken inside
  the transaction like every niko number, financial year in the prefix,
  counters back to 1 in April. A folder with no scheme of its own (and none
  inherited) gives no number.
- **Nothing is ever hard-deleted** by a user: the recycle bin is admin-only
  and a purge is an explicit admin act.

## 1. Library

**Records**
- `document_folders`: a tree (parent, name, sort order), with a *confidential*
  flag, a header note (Markdown: instructions shown at the top of the
  folder), the list columns it shows (optionally passed to subfolders), and
  its automatic approval route (§4). Seeded with: Legal, Licences & Registrations, Contracts &
  Agreements, Land & Lease, HR, Insurance, Vehicles, Correspondence (with
  Inward and Outward under it), Policies & Circulars, Bank & Finance,
  Miscellaneous.
- `document_types`: Licence, Agreement, Letter, Certificate, Policy,
  Notice, Invoice copy, ID proof, Other. Each type says which fields it
  carries (issue date, expiry, reference no., amount, party) and whether
  expiry is required.
- `document_number_schemes`: per folder — pattern (text, financial year,
  counter), next number, whether subfolders use it, reset each April.
  Settings lists every scheme and the documents under each, as a registry.
- `documents`: a number from its folder's scheme, if it has one (e.g.
  IN/2026-27/0001),
  title, folder, type, status
  (Draft → Under review → Approved → Signed → Expired → Archived, or Void),
  party (contact), employee, issue date, expiry date, reference no., amount,
  tags, the type's own fields, physical location (box / shelf / file), a
  retention-until date, the deleted-at/by of the recycle bin, and who/when.
- `document_links`: the document ↔ any niko record (vendor, customer,
  employee, house, location, bill, PO, invoice, receipt, vehicle/asset), and
  document ↔ document, shown on both.
- `document_reminders`: any number per document — date and time, a person or
  a role, a message, one-off or repeating (monthly, yearly…).
- `document_watches`: a person watching a document or a folder (this folder
  only / and everything below), for added, changed, moved, deleted, restored.

**Screens**
- The library: a folder tree on the left and a list on the right, as Zoho
  Books' Documents screen lays it out — the real Zoho screens are read before
  this is built. Each folder shows its header note and its chosen columns
  (any field, the number, expiry, status).
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
- Results **export to Excel**.
- **Duplicates:** the SHA-256 of every upload is kept; a file already on
  file is flagged at upload ("already filed as …") and listed in a report.

## 3. Correspondence register

- `correspondence`: direction (in / out), the number — **IN/2026-27/0001**,
  **OUT/2026-27/0001** (the schemes of the Inward and Outward folders) — and
  a **reply takes the number of the letter it answers plus a suffix**:
  IN/2026-27/0001-1, -2; a reply to that reply IN/2026-27/0001-1-1. The two
  are linked both ways automatically. The date, the mode (post, courier, hand, email,
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
  account with the provider. Phase 5. Outsiders sign **only** this way (or
  on paper): no emailed-link simple signing — decided 7 Oct 2026.
- **Signature requests:** one or more signers in order, each by in-app,
  DSC or Aadhaar, with reminders; the document shows who has signed.
- **Tamper check:** the stored hash is re-checked on every view; a changed
  file shows the signature as broken. A QR code on the document opens a
  public verification page (number, title, issuer, signers, hash OK / not).
- **Approval workflows:** reusable routes (e.g. Accountant → Director), steps
  in order or in parallel, approve / reject with a comment, status moving
  with them. A one-line question for the approvers ("Shall we pay this?"),
  editable until the first decision.
  - **Request clarification:** the approver asks someone else a question;
    the task stays open until they decide.
  - **Delegate** one task to another person, or name a **deputy** for a
    leave period who receives all tasks meanwhile; the record shows both
    names.
  - **Automatic by folder:** a folder can carry a route, so anything added
    to it goes for approval on its own, and can be **moved to another folder
    once approved** (e.g. Bills to approve → Bills approved).
  - Anyone who hasn't acted is reminded after 1 day and again after 6.
- **Read & acknowledge:** a policy or circular sent to people or roles; each
  confirms they have read it; the document shows who has and hasn't.

## 5. Expiry and compliance

- Expiry dates on any document; reminders 90, 30 and 7 days before; an
  **Expiring soon** list on the documents home and on the Home page.
- **Reminders** set by hand on any document (`document_reminders`), on top
  of the expiry ones.
- **Watch** a document or folder (`document_watches`): a notice when
  something in it is added, changed, moved, deleted or restored, optionally
  grouped into one daily summary.
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
- Folder permissions on top of roles, at Folderit's levels: **Previewer**
  (look only — no download or print), **Viewer** (also download and print),
  **Upload-only** (adds files, sees only their own), **Editor** (changes,
  moves, deletes) and **Manager** (also grants access), for a role or a named
  user; confidential folders are visible only to those named.
- **Every grant can expire** on a date and time, and is removed then.
- **Access overview** (admin): everyone with access to anything, and every
  live share link; remove item by item or all of a person's at once.
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

- **My tasks**, behind a bell with a count in the header: waiting for my
  signature, approval or acknowledgement, and my clarification questions;
  what I have sent others that is still pending; the history of my decisions
  and of my requests.
- Documents home: recent, my tasks, expiring soon, correspondence awaiting
  reply.
- Reports (on the Reports page, in a Documents card): the correspondence
  register, pending replies, the licence & expiry register, compliance gaps,
  the signature log, pending approvals, duplicates, storage used.

## Phases

1. **Library**: folders (header note, columns), per-folder numbering,
   types, documents, links, upload and phone scan, permissions with expiry,
   access overview, the events log, recycle bin, physical location; text
   extraction and search with Excel export (with the backfill of existing
   attachments); duplicate check; AI suggestions.
2. **Correspondence**: registers and numbering, replies numbered from the
   letter they answer, threads, assignment and reminders, letter templates
   with QR, the printed register.
3. **Expiry and compliance**: expiry reminders, hand-set reminders,
   watches, renewals, checklists, the expiring-soon lists, retention flags.
4. **Approvals and in-app signing**: workflows (clarification, delegation,
   deputies, automatic by folder, move once approved), My tasks,
   acknowledgements, in-app e-signature, tamper check, verification page,
   share links, watermark.
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
8. ~~Number formats~~ — **decided 7 Oct 2026:** numbering is per folder;
   at the start only Correspondence › Inward (**IN/2026-27/0001**) and
   Correspondence › Outward (**OUT/2026-27/0001**) carry a series. Every
   other folder starts unnumbered; a series can be added to any folder later.
9. **Who manages documents** — which roles get which folders at the start?
