# vavoo-iptv

This project is a small technical project that aggregates live streaming sources accessible through the Vavoo.to service in M3U and EPG (electronic program guide) formats and is automatically updated using GitHub Actions. Its purpose is to demonstrate how a Cloudflare Worker, helper scripts, and automation workflows can work together within the IPTV/M3U/EPG ecosystem.

## Important Notice — Copyright and Liability

This project **has no official affiliation with Vavoo.to or any broadcaster**, and the code in this repository does not imply ownership of the copyright for any broadcast content.

A significant portion of the channels accessible via Vavoo.to are distributed **unauthorized (pirated)** outside the broadcasting licensing systems of the relevant countries. Such distribution:

- Infringes on the rights of content owners and broadcasters,
- May be subject to legal and criminal penalties in many countries,
- Is **ethically wrong** and harms the producers, broadcasters, and content creators who put in the work.

This repository is **intended solely for technical/educational purposes**; it is meant to demonstrate how M3U, EPG, and broadcast parsing architectures can be implemented. Using this code to access, distribute, or broadcast unauthorized content commercially or on a mass scale is **entirely the user’s own decision and responsibility.** The project owner does not encourage or recommend such use and cannot be held responsible for its consequences.

## Contents

- `worker/` — Cloudflare Worker code that parses and routes stream sources
- `scripts/` — Utility scripts that update the channel list and data
- `.github/workflows/` — GitHub Actions definitions that automatically update the lists at set intervals
- `iptv.m3u` — Generated sample M3U playlist
- `epg.xml` — Sample EPG (electronic program guide) data generated
- `package.json` — Project dependencies and script definitions

## How It Works

1. The scripts collect channel and stream information published on Vavoo.to.
2. This data is converted to M3U and EPG formats.
3. The worker handles requests from clients and performs the task of routing/resolving them to the relevant stream.
4. The GitHub Actions workflow automatically repeats this process at set intervals.

## Setup (for local development)

```bash
git clone https://github.com/kadirmetin/vavoo-iptv.git

cd vavoo-iptv

npm install
```

To run the Worker locally and trigger the scripts, refer to the script definitions in `package.json`.

