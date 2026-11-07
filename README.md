# Asset Management Server

Express + MongoDB (native driver) API for the XYZ Asset Management System
(MI-12 · assignment12_category_0007).

## Run locally

```bash
npm install
# copy .env.example to .env and fill in your own values
npm start
```

Required env: `DB_USER`, `DB_PASS`, `ACCESS_TOKEN_SECRET`, `STRIPE_SECRET_KEY`, `PORT`.
Alternatively set `DB_URI` to a full MongoDB connection string.

## Auth

`POST /jwt` with `{ email }` returns a token. Send it as
`Authorization: Bearer <token>` (the client stores it in localStorage).

## Main endpoints

- Users: `POST /users`, `GET /user/:email`, `PATCH /users/profile`,
  `GET /unaffiliated-users`, `PATCH /add-to-team`,
  `PATCH /add-selected-to-team` (bulk, single call), `PATCH /remove-from-team/:email`,
  `GET /my-team`, `GET /employees/hr`
- Assets: `POST /assets`, `GET /assets/hr`, `GET /assets/employee`,
  `PATCH /assets/:id`, `DELETE /assets/:id`
- Requests: `POST /requests`, `GET /requests/my`, `GET /requests/hr`,
  `PATCH /requests/approve/:id`, `reject`, `cancel`, `return`
- Home: `GET /hr-stats`, `GET /employee-home`
- Payments: `POST /create-payment-intent`, `POST /payments`, `GET /payments/:email`
  — packages: 5 members $5 · 10 members $8 · 20 members $15

All list endpoints paginate at 10 per page and return `{ <items>, total }`.
Team size is always counted live from the users collection.
