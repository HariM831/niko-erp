# Folderit — what it actually does

Read 7 Oct 2026 from Folderit's public help centre (all 92 tutorials at
folderit.com/knowledge-base). This covers features and layout only. The app
itself has not been seen yet; a trial login is due from the user, and the
screens are to be checked against these notes before the library UI is built.
The plan this feeds is [documents-module-plan.md](documents-module-plan.md).

## Layout

- **Left column:** *Main Sections* — the top-level folders (new accounts get
  Inbox, #Team, Accounting, Human Resources), renamable, reorderable,
  `+ Create new section`. Below them the **Admin Tools** panel: Manage Users,
  User Groups, Access Overview, Audit Log, Recycle Bin, Metadata (fields and
  tags), Numbering, Form templates, Workflows (automations, templates,
  methods), Dashboard & Reports.
- **Folder list view:** toolbar of Upload ▾ (upload folder, add a link, new
  Word/Excel/PowerPoint, then the eForms below a dashed line), Modify, Meta,
  Columns, Numbering, Workflow, Audit log, Share, Download, Move, Duplicate,
  Delete. Checkboxes for bulk actions; drag handle to move.
  - A **header message** per folder, in Markdown (instructions for that
    folder: "upload contracts as PDF…").
  - **Columns** chosen per folder (default Name, Tags, Date; any metadata
    field, document number, retention end, file size), optionally inherited
    by subfolders. List values can carry a text and background colour.
  - Each row: file icon with a magnifier when a preview exists, status
    squares (approval ✓, sign ✎: yellow active / red rejected / green done;
    an eye for acknowledgement), a warning when required metadata is missing,
    a share icon that turns blue once shared, a download icon, a gear menu
    (Modify, Retention, Watch, Workflow, Duplicate…).
  - Footer: export the folder's contents (Excel/CSV/PDF) and the folder's own
    "Import files via email" address.
- **File detail view:** metadata — Title, Notes, Tags, Signed by, Document ID
  (automatic), Date, Due Date, plus the folder's custom fields; Related items;
  Versions; Workflows (each with status, participants, dates, expandable);
  Reminders; Shared to; Retention; and the **audit log** at the bottom. Right
  panel buttons: Start approval / acknowledgement / eSign, Upload new version,
  Lock file, Send as email, Edit in Word.
- **Bell** in the header with a count → **personal dashboard**: tasks
  assigned to me (sign, approve, review, acknowledge), my requests still
  pending with others, history of my decisions, history of my requests.

## Features, in the order of our plan

**Library and metadata**
- Fields are attached by **folder template** (`Meta`): each field Required /
  Recursive / which item types; created centrally under Admin → Metadata.
  Types: string, long text, checkbox, date, datetime, time, integer, decimal,
  list (with colours and an external key), email, URL, user, entity.
- Tags are central, hierarchical (sub-tags), and can be **shared**: sharing a
  tag gives access to everything tagged with it.
- **Related items:** document ↔ document/folder/link, shown both ways.
- Save & Next for working through a batch of uploads.
- Duplicate (files or whole folder trees, choosing what carries over), move
  by drag and drop, bulk ZIP download, external links stored as items.
- Upload: button, drag and drop, ZIP (≤500 MB, ≤500 files, unpacked),
  email-in, desktop sync, SFTP, API.

**Search**
- *Live search* while typing (names, metadata); *Deep search* on the button
  (adds file content via OCR, notes).
- Filters: item type / form, folder, date range, creator, relations,
  metadata conditions, **task filters** (method, state), extension, tags,
  signers, document number. Choose which areas the text is matched in.
- Operators: `"phrase"`, `+word`, `-word`. Results scored, sortable,
  **exportable to Excel/CSV**.
- Preview: up to 50 pages, search inside, copy text, zoom, print/download as
  permitted.

**Numbering**
- Set **per folder** (or per Main Section), optionally applying to
  subfolders: a scheme of text + date parts + counter, next number, reset
  yearly on a chosen month/day. Admin → Numbering lists every scheme and the
  documents under each, as a registry.
- Correspondence is done with eForms: an *Incoming letter* form, and a
  *Reply letter* created from it by a linked-form button. **The reply
  inherits the source number with a suffix** — IN-2026-001-1, -2; a reply to
  a reply IN-2026-001-1-1 — and both are linked automatically.

**Workflows (approval, acknowledgement, signing)**
- Started one-off on a file, **automatically on every file added to a
  folder**, from a saved **workflow template**, or by a visual automation
  (triggers, conditions, delays, moves; we don't need this).
- Order: parallel, serial, or custom stages; a stage can pass on all / N /
  N% acceptances and fail on N or N% rejections.
- A **resolution** line ("Shall we pay this?"), editable until the first
  decision. Approver: approve / reject with a comment and optional file,
  **request clarification** from someone else (task stays open),
  **delegate**; a **deputy** can be set for a leave period, and the trail
  shows both names.
- **Move after approval** to a chosen folder.
- Acknowledgement: invitees click Acknowledged; the document can be
  downloaded with a final page listing everyone's acknowledgement.
- Workflow summary download: the file plus a summary page, or a ZIP.
- eSign: the signer picks the page and **clicks where the signature goes**;
  outside parties sign from an emailed link with no account.
- Workflow reminders to whoever hasn't acted: default after 24 h and 144 h,
  adjustable by an admin.

**Expiry, reminders, retention**
- A **Due Date** field on every document; Dashboard → *Due Documents* =
  overdue or due in the next 30 days.
- **Reminders on any item:** date/time, people or a group, a message,
  one-off or recurring; several per item.
- Date-based reminder rules on form records (N days before a date field,
  with conditions).
- **Watch** a file or folder: email on added / updated / moved / deleted /
  restored, optionally grouped into a digest.
- Retention: per folder or file, from a chosen date field; at the end
  archive to a folder, send to the bin, or delete.

**Access**
- Levels: **Previewer** (look only, no download/print), **Viewer** (plus
  download/print), **Editor**, **Upload-only** (sees only their own
  uploads), Custom (each folder/file action separately).
- Shared to a user, a group (groups can contain groups), a tag, or a public
  link; every share can carry an **expiry date**.
- New users see only #Team until given more.
- **Access Overview:** every person with any access and every live public
  link, removable item by item or all at once.
- Public links: read-only, optional expiry, re-enabling makes a new URL,
  opens logged by IP.
- Audit trail on every item (views and downloads included, can't be
  edited) plus a **global audit log** filterable by date, user, scope and
  action, exportable.
- Recycle bin: admins only, 30 days then automatic purge.
- Watermark (viewer's name diagonally, date/time and file name in the
  footer) — a paid add-on there.

**Generation and forms**
- eForms: structured records (fields, tables, relations, files) that live in
  folders like documents; record name pattern from field values.
- Document generation: an ODT template with `{{ placeholders }}` → PDF or
  DOCX from a form record; generated files are ordinary documents.

**Admin reports**
- **Duplicates** found by file hash, pending approvals, nearing retention
  end, due documents, totals — all exportable.
