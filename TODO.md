## 🧩 Connectivity & Device Handling
- bluetooth auto reconnect bug: says "Bike BLE ready, sending initial trainer state." and then gets marked as successful in ui even though the connect failed
- pause workout when bike disconnected, and maybe don't start workout if bike disconnected

## 🖥️ UI / UX Issues & Improvements
- maybe add a bit more padding at the top of big number titles
- in product modals, or ideally local popup above FTP when selecting
- there are white lines between the segments in the workout chart
- there should be time tick marks on the x axis
- button focus should not have blue border
- workout selector should remember filters and also have hotkeys for workout types.

## 🔊 Notifications & Audio Feedback
- beep if the power change is greater than 5% to next interval, and the low beep is not audible
- do siren 10s before big spike, and different soudns for start vs end interval

## ⚙️ Workout Execution & Behavior
- erg and resistance flows are not implemented
- when workout ends, stop the timer, and continue showing target power, and also stop/save the workout
- investigate stability of the timer (uses system clock instead of settimeout)

## 📄 File, Data, and Parsing
- the workout history docs should also contain the zwo file (or at least the name and segments)
- maybe not necessary to put metrics in the zwo file or description?
- fix parsing of 1min 50sec @ 85rpm, 136W at https://whatsonzwift.com/workouts/threshold/atoverunder
- fix misclassificaiton of Over Under and Beyond as VO2max
- add url to workout website source
