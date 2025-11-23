# ZWO Downloader

**ZWO Downloader** is a Chrome extension that converts cycling workouts from **TrainerRoad**, **TrainerDay**, and **WhatsOnZwift** into Zwift `.zwo` workout files.
It detects supported workout pages, extracts or fetches segment data, reconstructs the workout structure (including ramps and structured intervals), computes workout metrics, and provides a one-click ZWO download.

---

## Supported Websites

The extension automatically activates on:

* **TrainerRoad**
  `https://www.trainerroad.com/app/cycling/workouts/add/<id>`

* **TrainerDay**
  `https://app.trainerday.com/workouts/<slug>`

* **WhatsOnZwift**
  `https://whatsonzwift.com/workouts/...`

---

## Features

* Extracts interval structure from:

  * TrainerRoad: `chart-data` (1-second samples)
  * TrainerDay: API lookup via `bySlug`
  * WhatsOnZwift: DOM parsing of interval blocks and cadence
* Generates fully Zwift-compatible `.zwo` files using:

  * **SteadyState**
  * **Warmup** / **Cooldown**
  * **IntervalsT** (auto-detected)
* Includes cadence when present (WhatsOnZwift)
* Computes workout metrics using your configured FTP:

  * **TSS**
  * **kJ**
  * **IF**
  * **Total duration**
* Adds metrics and source tags into the ZWO file
* Prints generated XML to the browser console for inspection
* One-click download via the extension toolbar icon

---

## Installation (Unpacked)

1. Clone the repository:

   ```bash
   git clone https://github.com/babymastodon/zwo-downloader.git
   cd zwo-downloader
   ```

2. Open `chrome://extensions` in Chrome.

3. Enable **Developer mode**.

4. Click **Load unpacked** and select the `src/` directory.

---

## Usage

1. Open a supported workout page (TrainerRoad, TrainerDay, or WhatsOnZwift).
2. Click the **ZWO Downloader** toolbar button.
3. The `.zwo` file downloads immediately.
4. The XML is also logged to the DevTools console.

---

## FTP Configuration

ZWO workouts always use **relative (%FTP)** values, as required by Zwift.
Your FTP setting is used **only to calculate the kJ metric** included in the exported ZWO file.

To set your FTP:

* Right-click the extension → **Options**

Your FTP is stored in Chrome sync storage and applies to all generated workouts.

---

## License

MIT License.
