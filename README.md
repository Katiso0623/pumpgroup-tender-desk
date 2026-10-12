# Pump Group Tender Desk

The website Pump Group SA uses to find and prepare public tenders: matching CE and ME tenders and quotations from every
province and municipality, what each bid needs, the document library, key personnel, company details and the cost model.

- **Website:** `site/`, published to GitHub Pages by `.github/workflows/pages.yml`. Everyone signs in; access is managed
  on the Team page by an administrator.
- **Data and files:** a private Supabase project. Nothing in this repository gives access to it: the key in
  `site/config.js` only identifies the project, and every table, function and file is behind the sign-in and the
  database's access rules.
- **Bid pack builder:** `builder/`, run by `.github/workflows/builder.yml` every 10 minutes when work is waiting. It
  proves who it is with GitHub's OIDC token, so no secrets are stored in this repository. It reads scanned tender
  documents and builds bid packs: a red filling guide for the original tender document, the returnables pack ready to
  print, editable cover and index, priced BoQ and cost model, envelope labels and the submission checklist.
- **Tender Desk prepares bids from the website:** "Prepare this bid" on a bid queues a request. A scheduled Tender Desk task
  (every hour on weekdays, 06:54 to 17:54 South African time) reads the tender documents, chooses the key personnel,
  writes the plan (returnables in the tender's order, functionality, method statement, programme, contract data) and
  hands it to the builder. Its instructions are in `builder/PREPARER_PROMPT.md`.
- **Uploads needed:** a tab that lists, for each bid, every document still to upload with what it must show, its date
  limit and an upload button, followed by everything to sign, certify and deliver by hand.
- **Tender scanning, screening and email alerts** run in Supabase and in scheduled Tender Desk tasks.
