# Wolfofbey - Dashboard

Sales KPI Dashboard for the Wolfofbey infoproduct business. Pulls live data from 6 Close CRM organizations and Teachable, generates a self-contained HTML dashboard.

**Owner:** Samer, CTO - Wolfofbey

---

## Quick Start

```bash
# Generate dashboard (current month)
node kpi_dashboard.js

# Custom date range
node kpi_dashboard.js --from 2026-02-01 --to 2026-02-28

# Output: kpi_dashboard.html (open in any browser)
```

---

## What the Dashboard Shows

### Per-Organization Tabs
Overview tab (aggregated) + one tab per org (Lebanon, UAE, Iraq, Jordan, Saudi Arabia, Qatar).

### KPIs

| Section | Metrics | Data Source |
|---------|---------|-------------|
| Summary Cards | Revenue, Cash Collected, Units Sold, New Leads, Close Rate, No Shows | Close CRM opps + lead custom fields |
| Closer Leaderboard | Sales Call Booked, Calls Taken, Offers Made, Units Sold, Closing Rate, Revenue, Cash | Close CRM opps + After Call Report activities |
| Revenue by Closer | Conic-gradient donut + ranked list | Lead custom field `Revenue` |
| Cash by Closer | Ranked list | Lead custom field `Cash Collected` |
| Setter Leaderboard | Setter name, Leads Set, Share %, Top Source | Setter custom activity |
| Sales Funnel | New Leads -> App Submitted -> Booked -> Offers -> Won (with drop-off %) | Lead status counts + opp counts |
| Speed Metrics | Lead to Opp, Opp to Won, Total Cycle (avg days) | Lead/opp date comparisons |
| Deal Analytics | Avg Deal Size, Total Revenue, Units Sold | Calculated from won leads |
| Leads by Country | Country from phone number country code | Lead contact phone field |
| Country Performance | Cross-org comparison table | All orgs aggregated |
| Lead Source (Won) | UTM Source / Lead Source of won leads | Lead custom field |
| Payment Type Mix | Full Pay vs Split Pay vs Follow Up Won | Won opp status labels |
| Payment Method | Stripe, Cash, Bank Transfer, Whish, etc. | Lead custom field `Payment Method` |
| Student Metrics | Enrollments, Avg Progress, Completion Rate, Active Rate | Teachable API |
| Lead Status Distribution | All-time status bar chart | Lead status counts |

### Date Filter
The HTML includes a filter bar with preset buttons (This Month, Last Month, Last 3 Months, Year to Date, All Time) and custom date pickers. Clicking a preset copies the CLI command to re-run with that date range.

---

## Architecture

### Data Flow
```
Close CRM API (6 orgs) ---> kpi_dashboard.js ---> kpi_dashboard.html
Teachable API ----------/
```

Single Node.js script, no server. Fetches data, calculates KPIs, generates static HTML. No frameworks, no build step.

### Close CRM Organizations

| Org | .env Key |
|-----|----------|
| Lebanon | `Lebanon_CLOSE_API_KEY` |
| UAE | `UAE_Close_API_KEY` |
| Iraq | `Iraq_Close_API_KEY` |
| Jordan | `Jordan_Close_API_KEY` |
| Saudi Arabia | `Saudi_Close_API_KEY` |
| Qatar | `Qatar_Close_API_KEY` |

Each org has separate API keys, custom activity type IDs, and custom field IDs. The script fetches these dynamically - no hardcoded IDs.

---

## Close CRM API Knowledge

### Authentication
HTTP Basic with `api_key:` (empty password):
```js
'Basic ' + Buffer.from(apiKey + ':').toString('base64')
```

### Key Endpoints Used
- `GET /api/v1/user/` - all users in org
- `GET /api/v1/status/lead/` - lead status definitions
- `GET /api/v1/custom_field/lead/` - lead custom field definitions
- `GET /api/v1/custom_activity/` - custom activity type list
- `GET /api/v1/custom_activity/{id}` - activity type fields
- `GET /api/v1/lead/?query=...&_limit=N&_fields=...` - search leads
- `GET /api/v1/lead/{id}/` - get single lead
- `GET /api/v1/opportunity/?status_type=won&date_won__gte=...` - filter opps
- `GET /api/v1/activity/?lead_id=...&_type=...` - get activities for a lead

### Critical API Quirks
- **Custom activity queries require `lead_id` filter** - cannot bulk-query all activities of a type globally. Must iterate through leads.
- **Custom field IDs differ per org** - same field name, different `cf_...` ID. Always resolve by name via `/custom_field/lead/` or `/custom_activity/{id}`.
- **Pagination** - `_limit` max 200, use `_skip` for pagination. Check `has_more` and `total_results`.
- **Lead custom fields** use human-readable names in the `custom` object (e.g., `lead.custom['Revenue']`).
- **Activity custom fields** use `cf_` IDs as keys (e.g., `activity['custom.cf_abc123']`).

### Custom Activity Types (per org, fetched dynamically)
| Activity | Purpose | Key Fields |
|----------|---------|------------|
| After Call Report | Filed after every sales call | `Made an Offer` (Yes/No), `Nationality` |
| Setter | Setter attribution | `Setter` (name), `Source`, `Country` |
| Full Pay | Full payment recorded | `Close Date`, `Course`, `Revenue`, `Payment Method` |
| Installments Plan | Installment payment recorded | `Close Date`, `Course`, `Revenue`, `Payment Method`, installment amounts |

### Units Sold Logic
A lead counts as a "unit sold" only when:
1. The lead has a **Full Pay** or **Installments Plan** custom activity
2. The activity's **Close Date** field falls within the selected date range
3. The activity's **Course** field is NOT "Dropservicing"

This is more accurate than counting won opportunities, which may include leads without payment activities filed yet.

### Closer Metrics Definitions
| Metric | How Calculated |
|--------|----------------|
| Sales Call Booked | Opps in "Demo Scheduled" status updated in date range |
| Calls Taken | Opps in "Demo Completed / Not Closed" + Won statuses updated in date range |
| Offers Made | After Call Report activities where "Made an Offer" = "Yes" in date range |
| Units Sold | Full Pay / Installments activities with Close Date in range (excl. Dropservicing) |
| Closing Rate | Units Sold / Calls Taken |
| Revenue | Lead custom field `Revenue` for won leads |
| Cash | Lead custom field `Cash Collected` for won leads |

### Setter Metrics
Setter name comes from the **Setter custom activity** (not the lead's custom field), specifically the `Setter` choices field. Source comes from the `Source` choices field on the same activity. Script iterates through recently updated leads and checks for Setter activities created in the date range.

### Lead Country Detection
Country is inferred from the phone number's country code prefix:
- `+961` = Lebanon, `+971` = UAE, `+964` = Iraq, `+962` = Jordan
- `+966` = Saudi Arabia, `+974` = Qatar, `+973` = Bahrain, etc.
Matching is done longest-prefix-first to avoid ambiguity.

---

## Teachable API

- Auth header: `apiKey` (not `Authorization`)
- Base URL: `https://developers.teachable.com/v1`
- Courses tracked: Engine 2.5 (2550705), Digital Empire 2.0 (1970075), School of Selling (2886758), Engine Arabia (2939871)
- Completion rate is **sampled** (3 pages of 20 students per course) - not exhaustive
- Max 20 results per page (`per` param)

---

## Brand Colors (Wolfofbey)
- Background: `#0C1115`
- Dark card: `#141C24`
- Border: `#1E2A35`
- Blue: `#1372D3`
- Red: `#CA2029`
- Gold: `#F5A623`
- Green: `#27AE60`
- Text: `#E8E8E8`
- Muted: `#8899AA`

---

## Existing Plecto Dashboard
The team already has a Plecto "Closer Leaderboard" dashboard connected to Close CRM showing: Total Revenue by closer, Units Sold by closer, Calls Booked/Taken/Offers/Close Rate table, Total Cash by closer, Revenue trend line chart. This KPI dashboard extends Plecto with: setter stats, funnel with drop-off, speed metrics, lead source attribution, payment method breakdown, phone-based country detection, Teachable student metrics, and cross-org comparison.

---

## .env Variables Required
```
Lebanon_CLOSE_API_KEY=...
UAE_Close_API_KEY=...
Iraq_Close_API_KEY=...
Jordan_Close_API_KEY=...
Saudi_Close_API_KEY=...
Qatar_Close_API_KEY=...
TEACHABLE_API_KEY=...
```

---

## Writing Rules
- NEVER use em dashes, en dashes, curly quotes, or other special Unicode characters
- Use plain hyphens (-), regular quotes, and simple punctuation only

---

## Potential Improvements
- Time-series charts (revenue/units over days)
- Setter-to-close attribution (which setter's leads converted to paid)
- Connect beycommerce.org for invoice data
- Auto-refresh on a schedule (n8n workflow or cron)
- Refund tracking from Teachable transactions
