# Netatmo iDiamant

This integration controls Bubendorff shutters fitted with an **iDiamant with Netatmo** gateway from Gladys Assistant: open, close, stop, set a percentage position, and report the real position back to the dashboard and to scenes.

## What is supported

- Bubendorff roller shutters (`NBR`)
- Orientable shutters / BSO (`NBO`) — height only, slat orientation is not exposed
- Swing shutters (`NBS`)
- Position from 0% (closed) to 100% (open), plus a stop command mid-travel
- Radio signal quality per shutter, and battery level on models that report one

Legrand / BTicino switches and plugs are out of scope: they use different Netatmo API scopes.

## Requirements

- An iDiamant gateway already installed, with your shutters paired and working in the **Home + Control** app (Legrand / Netatmo / BTicino). This integration does not handle pairing.
- A free Netatmo developer account, created with **the same credentials** as the app.
- An internet connection: the iDiamant API is cloud-only, there is no local API. Without internet the shutters still work from their remotes, but not from Gladys.

## Setup

### 1. Create a Netatmo application

Go to [dev.netatmo.com](https://dev.netatmo.com/apps/createanapp), sign in, and create an application. The fields it asks for (name, description, data protection officer name and email) are free text.

Once saved, the "App Technical Parameters" section shows your **client ID** and **client secret**.

### 2. Fill in Gladys

In the integration's **Configuration** tab:

1. Paste the client ID and client secret, then save.
2. Gladys displays the **redirect URI** to declare. Copy it into your Netatmo application settings byte for byte. This is the most common mistake: a URL that differs by one character fails with `redirect_uri_mismatch`.
3. Click **Connect**. Netatmo asks you to authorize access to your shutters (`read_bubendorff` and `write_bubendorff` scopes), then sends you back to Gladys.

### 3. Create the devices

Open the **Discovery** tab and run a scan. Your shutters show up with the name and room defined in Home + Control. Click "create" on each one you want to use.

Every shutter exposes:

| Feature | Description |
| --- | --- |
| Open / Close | Open, stop and close buttons |
| Position | Slider from 0 to 100% |
| Signal quality | Radio quality between the shutter and the gateway, in % |
| Battery | Only on shutters that report it |

### 4. Refresh interval

Netatmo pushes no events for shutters, so the integration polls the API. One minute is a good default. After any command sent from Gladys, the state is re-read automatically several times over the following thirty seconds anyway, while the shutter completes its travel.

The Netatmo API allows 500 requests per hour per user. Polling once a minute uses about 60, leaving plenty of headroom even if the same Netatmo account is used elsewhere.

## Action buttons

- **Test the connection**: checks the credentials and reports how many shutters were found.
- **Refresh states now**: forces an immediate re-read.
- **Send all shutters to their preferred position**: triggers the favourite position stored in each Bubendorff shutter (the remote's "preferred position" function).

## Troubleshooting

**"Netatmo account not linked"** — the client ID or client secret is missing, or the OAuth2 flow never completed. Save the credentials first, then click Connect.

**Connection fails with `redirect_uri_mismatch`** — the redirect URI declared at Netatmo does not exactly match the one Gladys shows. Copy it verbatim, without adding or removing a trailing slash.

**"Cannot reach the Netatmo API"** — the token expired and could not be renewed. Netatmo refresh tokens are single-use and rotate on every renewal; if one was consumed elsewhere (another tool using the same Netatmo application, for instance) you have to click Connect again. Prefer creating a separate Netatmo application per tool.

**No shutters in the Discovery tab** — check that the shutters are visible in Home + Control under the account you used, and that the iDiamant gateway is online.

**A shutter shows as unreachable** — the gateway lost the radio link. Look at the "Signal quality" feature: below 20% the link is too weak, and a repeater or a different gateway placement is needed.

**The position does not update immediately** — that is expected. Netatmo only reports the final position once the shutter has stopped, and a full travel takes about twenty seconds.
