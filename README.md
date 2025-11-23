# ZWO Downloader

**ZWO Downloader** is a Chrome extension that converts cycling workouts from **TrainerRoad**, **TrainerDay**, and **WhatsOnZwift** into Zwift `.zwo` workout files.
It detects supported workout pages, extracts or retrieves the underlying power-segment structure, reconstructs the workout with proper intervals and ramps, and provides a one-click ZWO download.

## Supported Websites

The extension automatically activates on:

* **TrainerRoad**
  `https://www.trainerroad.com/app/cycling/workouts/add/<id>`

* **TrainerDay**
  `https://app.trainerday.com/workouts/<slug>`

* **WhatsOnZwift**
  `https://whatsonzwift.com/workouts/...`

## Features

* Extracts workout structure directly from each site's data source:

  * TrainerRoad: `chart-data` (1-second samples) + `summary`
  * TrainerDay: API lookup via `bySlug`
  * WhatsOnZwift: DOM parsing of segment and metadata blocks
* Generates Zwift-compatible `.zwo` files using:

  * **SteadyState**
  * **Warmup** / **Cooldown**
  * **IntervalsT** (automatically detected from repeating interval pairs)
* Handles:

  * Accurate ramp detection
  * 1-second transition smoothing
  * Category inference (for WhatsOnZwift)
  * TSS, kJ, duration, IF, and source tags
* One-click download via the Chrome toolbar button
* Outputs the full generated XML to the DevTools console for inspection

## Installation (Unpacked)

1. Clone the repository:

   ```bash
   git clone https://github.com/babymastodon/zwo-downloader.git
   cd zwo-downloader
   ```

2. Open `chrome://extensions` in Chrome.

3. Enable **Developer mode**.

4. Click **Load unpacked** and select the `src/` directory.

## Usage

Navigate to a supported workout page on TrainerRoad, TrainerDay, or WhatsOnZwift.
Click the **ZWO Downloader** toolbar icon to download the corresponding `.zwo` file.
The extension also logs the generated XML to the browser console for debugging or verification.

## License

MIT License.
