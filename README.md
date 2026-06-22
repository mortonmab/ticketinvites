# Worship Moments — Invitation Studio

A small, self-hosted web app that turns the Worship Moments 2026 invitation
PDF into personalized invitations in bulk — one per guest — each with a unique
QR code for entrance verification and an optional clickable RSVP button that
feeds a live response dashboard.

Built with Node.js + Express. No database server, no build tools, no native
modules — it runs anywhere Node runs.

---

## What it does

- Upload the invitation PDF **once**.
- Visually **drag, resize and position** the guest name, the QR code, and an
  optional RSVP button directly on the template.
- Upload an Excel/CSV with a single column of **guest names**.
- Generate **one personalized PDF per guest**:
  - the name placed in your chosen font, size, colour and position;
  - a **unique QR code** that opens an entrance-verification page;
  - an optional **clickable RSVP button** linked to that guest.
- **Preview** a real sample, **generate** the whole batch, download **individual
  PDFs** or a **ZIP** of all of them.
- Guests open the RSVP link, confirm **Yes / No** and leave an optional comment.
- Track every response in the **RSVP dashboard** and **export to Excel**.
- At the door, scanning a guest's QR opens a verification page with a
  **Check in** button.

The app never sends anything itself — you download the PDFs and send them by
WhatsApp, email or print, exactly as you prefer.

---

## Requirements

- **Node.js 18 or newer** (check with `node --version`).

## Install & run

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

## Configuration (environment variables)

| Variable         | What it does                                                                 | Example                              |
|------------------|------------------------------------------------------------------------------|--------------------------------------|
| `PORT`           | Port to listen on (default `3000`).                                          | `PORT=8080`                          |
| `BASE_URL`       | **The public address where this app is reachable.** Baked into every QR code and RSVP link. | `BASE_URL=https://rsvp.yoursite.com` |
| `ADMIN_PASSWORD` | If set, the dashboard requires this password and the door check-in requires it as a PIN. If unset, the app runs in open mode. | `ADMIN_PASSWORD=choose-something`    |

Example (Mac/Linux):

```bash
ADMIN_PASSWORD=worship2026 BASE_URL=https://rsvp.yoursite.com PORT=3000 npm start
```

You can also set the public link from the field in the top bar of the
dashboard — that value is saved and overrides `BASE_URL`.

---

## ⚠️ Important: the QR codes and RSVP links need a public URL

A QR code scanned on someone's phone, or an RSVP button tapped from a downloaded
PDF, has to reach **this running app over the internet**. `localhost` only works
on your own machine.

So before you generate the real batch, make sure `BASE_URL` (or the "Public
link" field) points at an address the outside world can open. Options:

- Deploy the app to a small server / VPS / a host like Render or Railway and use
  that HTTPS address.
- For a quick public address while the app runs on your laptop, a tunnel such as
  `ngrok http 3000` or a Cloudflare Tunnel gives you a temporary public URL —
  paste it into the "Public link" field, then generate.

If you generate with the wrong base URL, just fix the URL and **generate again**
(see the note on regenerating below).

---

## Using the dashboard

1. **Invitation template** — upload the Worship Moments PDF.
2. **Guest names** — upload an `.xlsx` or `.csv`. The first column is treated as
   the name; a header row like "Invitee Name" is ignored automatically.
3. **Position & style** — drag the **Name**, **QR** and (if enabled) **RSVP**
   boxes onto the template. Drag the gold dot on a box to resize it. Set the
   name's font, size, alignment and colour, and the QR size. Turn on the RSVP
   button if you want one, and set its text and colours.
4. **Preview & generate** — "Preview sample invitation" renders a real PDF using
   the first guest's name, so what you see is exactly what prints. When happy,
   "Generate all invitations", then download the ZIP or individual PDFs.
5. **RSVP Responses** tab — see who's attending, when they replied, their
   comments and who's checked in. "Export to Excel" downloads the full list.

### At the event entrance

Scan a guest's QR with any phone camera. It opens a page showing their name and
RSVP status with a **Check in** button. If you set an `ADMIN_PASSWORD`, staff
enter it once as the gate PIN.

---

## Good to know

- **Where data lives:** everything is stored in the `data/` folder next to the
  app — `data/db.json` (guests + RSVPs), `data/template.pdf`, and the generated
  PDFs in `data/output/`. Back up this folder if you want to keep records.
- **Regenerating:** each "Generate all invitations" run starts a fresh batch —
  it clears the previous PDFs and assigns new IDs. Any QR codes / RSVP links from
  an earlier batch stop working, so only re-generate if you intend to re-send.
- **File size:** each invitation is roughly the size of your template, because
  the full template is preserved on every page (to keep the premium look). If
  the template is large and you'll send PDFs over WhatsApp, compress the source
  PDF once before uploading — every generated invitation then inherits the
  smaller size.
- **Names with accents** (e.g. "José") are rendered using the standard PDF fonts;
  accented letters are folded to their plain form so they always print cleanly.

---

## Project layout

```
worship-invites/
├─ src/
│  ├─ server.js     Express routes (admin API + public RSVP/verify pages)
│  ├─ store.js      File-backed JSON data store (atomic writes)
│  ├─ generate.js   PDF generation: name, QR, clickable RSVP link
│  └─ pages.js      Public RSVP form / thank-you / verification pages
├─ public/
│  ├─ index.html    Admin dashboard
│  ├─ app.js        Dashboard logic + drag/resize positioning
│  ├─ styles.css
│  └─ vendor/       pdf.js (renders the template for positioning)
├─ data/            Created at runtime (guests, template, output PDFs)
└─ package.json
```
