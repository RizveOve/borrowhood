# Demo accounts

Login details for trying out BorrowHood, locally (http://localhost:3000) and on the live demo (https://borrowhood.netlify.app).

These accounts are created by the demo seed: `npm run seed:demo` locally, or automatically on Netlify unless `SEED_DEMO=0`. They're for demonstration only; don't reuse these passwords anywhere.

## Users

| Name | Email | Password | Neighbourhood | Join code | Flat |
|---|---|---|---|---|---|
| Kari Nordmann | `kari@example.com` | `password123` | Solsiden Borettslag (Trondheim) | `DEMO42` | H0201 |
| Ola Hansen | `ola@example.com` | `password123` | Solsiden Borettslag (Trondheim) | `DEMO42` | H0305 |
| Amira Haddad | `amira@example.com` | `password123` | Solsiden Borettslag (Trondheim) | `DEMO42` | U0102 |
| Jonas Berg | `jonas@example.com` | `password123` | Moholt Studentby (Trondheim) | `MOHO24` | Block 7, 304 |
| Lin Chen | `lin@example.com` | `password123` | Moholt Studentby (Trondheim) | `MOHO24` | Block 3, 112 |

## What each account shows

| Account | Good for showing |
|---|---|
| Kari | Approving a request: Ola wants to borrow her hammer drill. Borrowing: the bike repair stand is due back tomorrow (return reminder), and she has an approved projector loan from Moholt |
| Ola | Lending: his waffle iron is overdue with Amira (overdue alert) and his bike stand is out with Kari; try **Mark returned** |
| Amira | An overdue loan as the borrower |
| Jonas / Lin | A second neighbourhood, for the neighbourhood filter |

## Master admin

| Role | Email | Password |
|---|---|---|
| Master admin | `admin@borrowhood.no` | Whatever `ADMIN_PASSWORD` is set to |

The admin password is not stored in this repository:
- **Locally:** it's `ADMIN_PASSWORD` in your `.env` file (`change-me-please` if you copied `.env.example`).
- **On Netlify:** it's the `ADMIN_PASSWORD` environment variable under **Site configuration → Environment variables**. Change it there and redeploy to reset it.
