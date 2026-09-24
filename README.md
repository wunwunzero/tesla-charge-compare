# Charge Compare

A small phone-first web app that answers one question: **which charger is cheaper to drive to right now?**
Built for a Tesla Model 3 Long Range AWD (2024) in Malaysia, including the Gentari "RM5 for RM30 credit" deal.

Live: https://wunwunzero.github.io/tesla-charge-compare/

## What it does

- Takes your current battery % and target %, your GPS position (or a searched place), and two to four chargers.
- Gets real driving distance and time to each charger from Google's Routes API, with live traffic.
- Works out the **all-in cost** of each option and tells you where to go:
  - **Charging**: kWh billed to reach the target, including the energy you burn driving there and AC/DC charging losses, at the station's RM/kWh. Gentari-flagged stations pay RM5 per RM30 of credit, so the effective rate is one sixth.
  - **Parking**: per station, flat or hourly, with an optional different rate for later hours, free minutes, a daily cap, separate weekend/public-holiday rates, and a free-parking entry window (e.g. Pavilion Damansara Heights: free if you arrive 6pm to 11:59pm on weekdays), checked against your arrival time. Parked time = charging time + the minutes you stay plugged in afterwards. Weekday or weekend is taken from the phone's clock, or set it in the Trip card.
  - **Idle fee**: per station RM/min after a free period, applied to the minutes you say you'll stay plugged in after charging stops. Gentari defaults to RM0.40/min after 15 minutes.
  - **Tyres and wear**: a flat RM/km.
  - **Consumption follows speed**: each leg's Wh/km is blended between a city figure (40 km/h or slower) and a highway figure (90 km/h or faster) from Google's distance and time.
  - **Minimum arrival %**: chargers you'd reach below it are never recommended.
  - **Time is shown, not priced**: driving minutes plus an estimated charging session, using a Model 3 LR DC charging curve capped by the charger's kW (AC capped at the 11 kW onboard charger). The verdict says how many minutes longer the cheaper option takes, and what that works out to in ringgit saved per extra hour.
- **Gentari credit sessions**: if a Gentari charger is in the comparison, the session is one RM5 top-up worth RM30 of charging (about 23 kWh at RM1.30) and stops there. Every other charger is compared on adding the same energy, so the totals stay apples to apples.
- **Cheapest near me**: ranks your saved chargers plus EV chargers Google finds within a chosen radius, routed from your position, by all-in cost and total time. Google results are priced from an editable operator table (Gentari, Tesla, chargEV, JomCharge, ChargeSini, DC Handal, TNB Electron, Shell Recharge, Charge N Go) and flagged as estimates; power and DC/AC come from Google's connector data where available.
- **Trip modes**: one way to the charger, round trip back to where you are, or via the charger on the way to a destination, where only the extra kilometres and minutes over driving direct count. Round trip and via modes also show the % you arrive home or at the destination with.
- **Plain results**: one answer card (where to go, how much cheaper, how much longer, and whether that trade is worth it), then every option as a card with its all-in price, time and battery, and a tap-to-open breakdown. Navigate opens Google Maps, Waze or Apple Maps; in via-charger mode Google Maps routes to your destination with the charger as a stop.
- **History**: log the charger you chose, then enter the kWh, RM, minutes and the % you ended at from the receipt. The app reports how far its predictions are off and, with two or more receipts per charger type, offers one tap to set the charging-loss % to what your receipts imply. Copy everything as CSV.
- **Route cache**: Google route results are kept for ten minutes across reloads, so repeated Compare taps while you tweak numbers cost nothing.
- Remembers your regular chargers on the device so you pick them from a list.
- Falls back to manual km/minutes when there is no API key or no signal. Installable to the home screen and usable offline in manual mode.

Every option is compared at the same end state (same target %), so the numbers are apples to apples.

## Setup

1. Open the site, tap the gear, and paste a Google Maps API key. Nothing is sent anywhere except Google; the key lives only in your browser's storage.
2. In Google Cloud, the key needs these APIs enabled: **Maps JavaScript API**, **Places API (New)**, **Routes API**.
   Restrict the key to HTTP referrer `https://wunwunzero.github.io/*`.
3. Add your regular chargers under "Saved chargers" (name, location, RM/kWh, AC/DC, kW, parking fee, Gentari deal yes/no).
4. On iPhone: Share → Add to Home Screen.

## Assumptions you can change in Settings

| Setting | Default | Note |
|---|---|---|
| Usable battery | 75 kWh | 2024 M3 LR AWD, ~78 kWh gross |
| Consumption | 140 city / 170 highway Wh/km | blended by each leg's average speed |
| Minimum arrival | 10% | options below are never recommended |
| AC / DC losses | 10% / 5% | you pay for billed kWh, not pack kWh |
| Onboard AC limit | 11 kW | |
| Wear | RM 0.08/km | tyres, brakes, depreciation share |
| Gentari deal | RM 5 → RM 30 | one top-up per session, then stop |
| Nearby radius | 5 km | 3 to 20 km |

## Files

Plain HTML, CSS and JavaScript. No build step, no dependencies, no backend.

- `index.html`, `styles.css`, `app.js`: the app
- `sw.js`, `manifest.webmanifest`, icons: home-screen install and offline shell
